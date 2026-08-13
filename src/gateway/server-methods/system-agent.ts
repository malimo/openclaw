import { randomUUID } from "node:crypto";
// OpenClaw gateway methods host the setup/repair conversation for clients.
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  buildSystemAgentInferenceUnavailableErrorDetails,
  buildSystemAgentSessionInvalidatedErrorDetails,
  ErrorCodes,
  errorShape,
  validateSystemAgentChatParams,
  validateSystemAgentChatHistoryParams,
  type SystemAgentChatQuestion,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
  type SystemAgentApprovalRequestPayload,
} from "../../infra/system-agent-approvals.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../runtime.js";
import {
  SystemAgentChatEngine,
  SystemAgentWizardAnswerError,
} from "../../system-agent/chat-engine.js";
import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
import {
  acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion,
  loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting,
} from "../../system-agent/greeting.js";
import { isSystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { buildNewAgentWelcome } from "../../system-agent/new-agent-welcome.js";
import { buildOnboardingWelcome } from "../../system-agent/onboarding-welcome.js";
import { describeSystemAgentPersistentOperation } from "../../system-agent/operations.js";
import {
  appendTranscriptReset,
  appendTranscriptTurn,
  readTranscriptTail,
} from "../../system-agent/transcript-store.js";
import {
  buildRequestedApprovalEvent,
  handlePendingApprovalRequest,
  listVisiblePendingApprovalRequests,
} from "./approval-shared.js";
import { sanitizeSystemAgentChatParams } from "./system-agent-chat-params.js";
import {
  buildSystemAgentChatResult,
  getSystemAgentChatInputError,
  runSystemAgentChatInput,
} from "./system-agent-chat-turn.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";
import {
  assertSystemAgentSessionStoreActive,
  disposeSystemAgentSession,
  initializeSystemAgentSession,
} from "./system-agent-session-lifecycle.js";
import { systemAgentSetupHandlers } from "./system-agent-setup.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/**
 * `openclaw.chat` lets clients (macOS app onboarding, future UIs) run the
 * same conversational setup as `openclaw setup`. Structured setup owns
 * the pre-inference phase; a new chat session starts only after a live model
 * turn succeeds.
 *
 * The bounded session map owns only in-flight wizard and approval state. The
 * sanitized conversation is a durable machine-wide logbook; `reset: true`
 * replaces the in-memory session without deleting that transcript.
 */
export type SystemAgentChatSession =
  GatewayRequestContext["systemAgentSessions"] extends Map<string, infer Session> ? Session : never;

const MAX_SYSTEM_AGENT_ACTIVE_SESSIONS = 8;
// Recovery entries free active capacity without making retained engines unbounded.
const MAX_SYSTEM_AGENT_SESSION_ENTRIES = 16;
const SYSTEM_AGENT_SEED_HISTORY_LIMIT = 30;
const DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT = 100;
const systemAgentSessionQueues = new WeakMap<
  Map<string, SystemAgentChatSession>,
  KeyedAsyncQueue
>();

function getSystemAgentSessionQueue(
  sessions: Map<string, SystemAgentChatSession>,
): KeyedAsyncQueue {
  let queue = systemAgentSessionQueues.get(sessions);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    systemAgentSessionQueues.set(sessions, queue);
  }
  return queue;
}

function acknowledgeDeliveredSystemAgentWelcome(session: SystemAgentChatSession): void {
  const auditSequence = session.welcomeAuditSequence;
  if (auditSequence === undefined) {
    return;
  }
  acknowledgeSystemAgentGreetingDelivery({ auditSequence });
  delete session.welcomeAuditSequence;
}

function resolveSystemAgentSessionOwnerKey(params: {
  delegation?: { agentId?: string; sessionKey?: string };
  client: GatewayClient | null;
}): string | undefined {
  const delegationKey = resolveSystemAgentDelegationKey(params.delegation);
  if (delegationKey !== undefined) {
    // Delegation is the host-only, cross-connection owner asserted by the regular-agent
    // tool path. Keep its agent/session tuple authoritative across gateway reconnects.
    return delegationKey;
  }
  // Authenticated users survive reconnects and may span paired devices. Otherwise
  // bind to the verified device, with the server-issued connection as a last resort.
  const userId = params.client?.authenticatedUserId?.trim();
  if (userId) {
    return `user:${userId}`;
  }
  const deviceId = params.client?.connect.device?.id.trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }
  const connId = params.client?.connId?.trim();
  return connId ? `connection:${connId}` : undefined;
}

type SystemAgentSessionCapacity =
  | { status: "admit" }
  | { status: "replace"; sessionId: string; session: SystemAgentChatSession }
  | { status: "full" };

function planSystemAgentSessionCapacity(
  sessions: Map<string, SystemAgentChatSession>,
): SystemAgentSessionCapacity {
  let activeSessionCount = 0;
  const protectedQrSessions = new Map<string, { key: string; lastUsedAt: number }>();
  const recoveryKeys = new Set<string>();
  for (const [key, session] of sessions) {
    if (session.engine.hasRecoverableQrReply()) {
      recoveryKeys.add(key);
      continue;
    }
    activeSessionCount += 1;
    if (!session.engine.hasPendingQrCode()) {
      continue;
    }
    const current = protectedQrSessions.get(session.ownerKey);
    if (!current || session.lastUsedAt >= current.lastUsedAt) {
      protectedQrSessions.set(session.ownerKey, { key, lastUsedAt: session.lastUsedAt });
    }
  }
  if (
    activeSessionCount < MAX_SYSTEM_AGENT_ACTIVE_SESSIONS &&
    sessions.size < MAX_SYSTEM_AGENT_SESSION_ENTRIES
  ) {
    return { status: "admit" };
  }
  const protectedKeys = new Set([...protectedQrSessions.values()].map(({ key }) => key));
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, session] of sessions) {
    // Recovery leases are a separate bounded pool: admission may use the freed
    // active slot, but cannot destroy a retained poll reply whose delivery was lost.
    if (protectedKeys.has(key) || recoveryKeys.has(key)) {
      continue;
    }
    if (session.lastUsedAt < oldestAt) {
      oldestAt = session.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    const oldest = sessions.get(oldestKey);
    if (oldest) {
      return { status: "replace", sessionId: oldestKey, session: oldest };
    }
  }
  return { status: "full" };
}

function persistEngineHistory(engine: SystemAgentChatSession["engine"], startIndex: number): void {
  const at = Date.now();
  for (const turn of engine.historySince(startIndex)) {
    // Engine history is authoritative here: sensitive user text has already
    // been replaced by the mask marker before it crosses this boundary.
    appendTranscriptTurn({ ...turn, at });
  }
}

function queueDelegatedApproval(params: {
  context: GatewayRequestContext;
  sessions: Map<string, SystemAgentChatSession>;
  session: SystemAgentChatSession;
  sessionId: string;
  delegation: {
    agentId?: string;
    sessionKey?: string;
  };
  proposal: NonNullable<ReturnType<SystemAgentChatSession["engine"]["getPendingOperatorProposal"]>>;
}): string {
  if (params.session.pendingApproval?.proposalHash === params.proposal.hash) {
    return params.session.pendingApproval.id;
  }
  const manager = params.context.systemAgentApprovalManager;
  if (!manager) {
    throw new Error("OpenClaw approval registry unavailable");
  }
  const description = describeSystemAgentPersistentOperation(params.proposal.operation);
  const request: SystemAgentApprovalRequestPayload = {
    title: "OpenClaw change",
    description,
    command: description,
    proposalHash: params.proposal.hash,
    allowedDecisions: SYSTEM_AGENT_APPROVAL_DECISIONS,
    agentId: params.delegation?.agentId ?? null,
    sessionKey: params.delegation?.sessionKey ?? null,
    sessionId: params.sessionId,
    turnSourceChannel: null,
    turnSourceAccountId: null,
  };
  const record = manager.create(
    request,
    SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
    `system-agent:${randomUUID()}`,
  );
  const decisionPromise = manager.register(record, SYSTEM_AGENT_APPROVAL_TIMEOUT_MS);
  params.session.pendingApproval = { id: record.id, proposalHash: params.proposal.hash };
  const requestEvent = buildRequestedApprovalEvent(record);
  void handlePendingApprovalRequest({
    manager,
    record,
    decisionPromise,
    respond: () => undefined,
    context: params.context,
    requestEventName: "openclaw.approval.requested",
    requestEvent,
    twoPhase: true,
    deliverRequest: () => false,
    keepPendingWithoutRoute: true,
    requireDeliveryRoute: false,
    afterDecision: async (decision) =>
      await runWithGatewayIndependentRootWorkContinuation(() =>
        runSystemAgentGatewayTask(async () => {
          // The original request has returned; keep approval, audit, and restart drain-visible.
          if (params.sessions.get(params.sessionId) !== params.session) {
            return;
          }
          if (params.session.pendingApproval?.id === record.id) {
            params.session.pendingApproval = undefined;
          }
          await params.session.engine.resolveOperatorApproval(decision, params.proposal.hash);
        }),
      ),
    afterDecisionErrorLabel: "OpenClaw approval apply failed",
  });
  return record.id;
}

export const systemAgentHandlers: GatewayRequestHandlers = {
  ...systemAgentSetupHandlers,
  "openclaw.approval.list": async ({ respond, client, context }) => {
    const manager = context.systemAgentApprovalManager;
    respond(
      true,
      manager ? listVisiblePendingApprovalRequests({ manager, client }) : [],
      undefined,
    );
  },
  "openclaw.chat.history": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentChatHistoryParams,
        "openclaw.chat.history",
        respond,
      )
    ) {
      return;
    }
    respond(
      true,
      { turns: readTranscriptTail(params.limit ?? DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT) },
      undefined,
    );
  },
  "openclaw.chat": async ({ params: rawParams, respond, client, context }) => {
    const params = sanitizeSystemAgentChatParams(rawParams);
    if (!assertValidParams(params, validateSystemAgentChatParams, "openclaw.chat", respond)) {
      return;
    }
    const inputError = getSystemAgentChatInputError(params);
    if (inputError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, inputError));
      return;
    }
    await runSystemAgentGatewayTask(async () => {
      const sessions = context.systemAgentSessions;
      const sessionId = params.sessionId;
      // Initialization, resets, and turns share one per-session queue. Without
      // it, concurrent first messages can create competing engines and lose
      // conversation state when the later initializer replaces the first.
      await getSystemAgentSessionQueue(sessions).enqueue(sessionId, async () => {
        assertSystemAgentSessionStoreActive(sessions);
        const supportsQrCode = hasGatewayClientCap(
          client?.connect.caps,
          GATEWAY_CLIENT_CAPS.SYSTEM_AGENT_QR_CODE,
        );
        const ownerKey = resolveSystemAgentSessionOwnerKey({
          delegation: params.delegation,
          client,
        });
        if (!ownerKey) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw caller identity unavailable."),
          );
          return;
        }
        const connectionOwnerId = ownerKey.startsWith("connection:")
          ? client?.connId?.trim()
          : undefined;
        const rejectInactiveConnectionOwner = (): boolean => {
          if (!connectionOwnerId || context.isConnectionActive?.(connectionOwnerId) !== false) {
            return false;
          }
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "OpenClaw connection is no longer active.", {
              details: buildSystemAgentSessionInvalidatedErrorDetails(),
            }),
          );
          return true;
        };
        const boundSession = sessions.get(sessionId);
        if (boundSession && boundSession.ownerKey !== ownerKey) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw session belongs to another caller.", {
              details: buildSystemAgentSessionInvalidatedErrorDetails(),
            }),
          );
          return;
        }
        if (boundSession && !params.reset && boundSession.supportsQrCode !== supportsQrCode) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "OpenClaw session capabilities changed; reset the session before continuing.",
              { details: buildSystemAgentSessionInvalidatedErrorDetails() },
            ),
          );
          return;
        }
        if (params.reset) {
          const existing = sessions.get(sessionId);
          // Persist the reset first; a failed write must leave the live session intact.
          appendTranscriptReset();
          if (existing) {
            await disposeSystemAgentSession({
              sessions,
              sessionId,
              session: existing,
              approvalManager: context.systemAgentApprovalManager,
              reason: "session-reset",
            });
          }
        }
        let session = sessions.get(sessionId);
        if (
          (params.wizardAnswer !== undefined ||
            params.wizardCancel !== undefined ||
            params.pollStepId !== undefined) &&
          !session
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              params.wizardCancel !== undefined
                ? "No active OpenClaw chat session is awaiting that wizard cancel."
                : "No active OpenClaw chat session is awaiting that wizard step.",
              { details: buildSystemAgentSessionInvalidatedErrorDetails() },
            ),
          );
          return;
        }
        let greetingAuditSequence: number | undefined;
        const welcomeOnly =
          params.wizardAnswer === undefined &&
          params.wizardCancel === undefined &&
          params.pollStepId === undefined &&
          (params.message === undefined || !params.message.trim());
        if (!session) {
          session = await initializeSystemAgentSession(
            sessions,
            sessionId,
            async ({ ownEngine, commitSession }) => {
              const { verifySystemAgentInferenceWithFallback } =
                await import("../../system-agent/inference-fallback.js");
              const inference = await verifySystemAgentInferenceWithFallback({
                ...(params.delegation ? { requestingAgentId: params.delegation.agentId } : {}),
                runtime: defaultRuntime,
              });
              if (!inference.ok) {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.UNAVAILABLE,
                    `OpenClaw requires working inference: ${inference.error}`,
                    {
                      details: buildSystemAgentInferenceUnavailableErrorDetails(),
                    },
                  ),
                );
                return;
              }
              // The gateway surface must never install/restart its own daemon; the
              // engine's setup path honors this via surface: "gateway".
              const engine = new SystemAgentChatEngine({
                surface: "gateway",
                supportsQrCode,
                verifiedInference: inference.binding,
                operatorApprovalOnly: params.delegation !== undefined,
              });
              ownEngine(engine);
              // `reset: true` keeps the durable logbook but deliberately starts
              // model context clean; only ordinary fresh sessions receive its tail.
              if (!params.reset) {
                engine.seedHistory(
                  readTranscriptTail(SYSTEM_AGENT_SEED_HISTORY_LIMIT, { afterLastReset: true }).map(
                    ({ role, text }) => ({ role, text }),
                  ),
                );
              }
              const welcomeHistoryStart = engine.historyLength();
              let welcome: string;
              let welcomeQuestion: SystemAgentChatQuestion | undefined;
              try {
                if (params.welcomeVariant === "onboarding") {
                  const onboardingWelcome = await buildOnboardingWelcome({ engine });
                  welcome = onboardingWelcome.text;
                  welcomeQuestion = onboardingWelcome.question;
                } else if (params.welcomeVariant === "new-agent") {
                  welcome = buildNewAgentWelcome({ engine });
                } else {
                  const overview = await engine.loadOverview();
                  const facts = loadSystemAgentGreetingFacts();
                  greetingAuditSequence = facts.auditSequence;
                  welcome = (
                    await resolveSystemAgentGreeting({
                      overview,
                      facts,
                      planner: (plannerParams) => engine.planGreeting(plannerParams),
                      allowInference: welcomeOnly,
                    })
                  ).text;
                  welcomeQuestion = buildSystemAgentGreetingQuestion(overview, facts);
                  engine.noteAssistantMessage(welcome);
                }
              } catch (error) {
                if (!isSystemAgentInferenceUnavailableError(error)) {
                  throw error;
                }
                respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
                return;
              }
              // A dead connection-only request cannot consume capacity by
              // destructively evicting another caller's live session.
              if (rejectInactiveConnectionOwner()) {
                return;
              }
              const capacity = planSystemAgentSessionCapacity(sessions);
              if (capacity.status === "full") {
                respond(
                  false,
                  undefined,
                  errorShape(
                    ErrorCodes.UNAVAILABLE,
                    "OpenClaw chat capacity is reserved for active or recoverable QR operations; try again after one completes.",
                    { retryable: true },
                  ),
                );
                return;
              }
              assertSystemAgentSessionStoreActive(sessions);
              persistEngineHistory(engine, welcomeHistoryStart);
              if (rejectInactiveConnectionOwner()) {
                return;
              }
              const displacedCleanup = commitSession(
                {
                  engine,
                  welcome,
                  ...(welcomeQuestion ? { welcomeQuestion } : {}),
                  ...(greetingAuditSequence !== undefined
                    ? { welcomeAuditSequence: greetingAuditSequence }
                    : {}),
                  lastUsedAt: Date.now(),
                  ownerKey,
                  supportsQrCode,
                },
                capacity.status === "replace"
                  ? {
                      sessionId: capacity.sessionId,
                      session: capacity.session,
                      approvalManager: context.systemAgentApprovalManager,
                      reason: "session-evicted",
                    }
                  : undefined,
              );
              void displacedCleanup?.catch((error: unknown) => {
                context.logGateway.warn(
                  `OpenClaw displaced-session cleanup failed: ${formatErrorMessage(error)}`,
                );
              });
            },
          );
          if (!session) {
            return;
          }
          if (welcomeOnly) {
            respond(
              true,
              {
                sessionId,
                reply: session.welcome,
                action: "none",
                ...(session.welcomeQuestion ? { question: session.welcomeQuestion } : {}),
              },
              undefined,
            );
            acknowledgeDeliveredSystemAgentWelcome(session);
            return;
          }
        }
        session.lastUsedAt = Date.now();
        // Inline check (not `welcomeOnly`) so TS narrows params.message below.
        if (
          params.wizardAnswer === undefined &&
          params.wizardCancel === undefined &&
          params.pollStepId === undefined &&
          (params.message === undefined || !params.message.trim())
        ) {
          respond(
            true,
            {
              sessionId,
              reply: session.welcome,
              action: "none",
              ...(session.welcomeQuestion ? { question: session.welcomeQuestion } : {}),
            },
            undefined,
          );
          acknowledgeDeliveredSystemAgentWelcome(session);
          return;
        }
        const historyStart = session.engine.historyLength();
        let reply: Awaited<ReturnType<SystemAgentChatEngine["handle"]>>;
        try {
          const turnReply = await runSystemAgentChatInput({
            engine: session.engine,
            input: params,
          });
          if (!turnReply) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw chat input is missing."),
            );
            return;
          }
          reply = turnReply;
        } catch (error) {
          persistEngineHistory(session.engine, historyStart);
          if (error instanceof SystemAgentWizardAnswerError) {
            const options =
              params.pollStepId === undefined
                ? undefined
                : { details: buildSystemAgentSessionInvalidatedErrorDetails() };
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, error.message, options),
            );
            return;
          }
          if (!isSystemAgentInferenceUnavailableError(error)) {
            throw error;
          }
          // A failed inference turn invalidates this conversation. Remove the
          // exact engine before cleanup so a retry must pass the live gate and
          // cannot resume partial proposal or CLI-session state.
          // Initialization failures stay unmarked because no live session existed.
          try {
            await disposeSystemAgentSession({
              sessions,
              sessionId,
              session,
              approvalManager: context.systemAgentApprovalManager,
              reason: "inference-unavailable",
            });
          } catch {
            // The inference error is authoritative; cleanup stays best-effort.
          }
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, error.message, {
              details: buildSystemAgentSessionInvalidatedErrorDetails(),
            }),
          );
          return;
        }
        persistEngineHistory(session.engine, historyStart);
        const delegation = params.delegation;
        let proposalId: string | undefined;
        if (delegation) {
          const proposal = session.engine.getPendingOperatorProposal();
          if (proposal) {
            proposalId = queueDelegatedApproval({
              context,
              sessions,
              session,
              sessionId,
              delegation,
              proposal,
            });
          }
        }
        respond(true, buildSystemAgentChatResult({ sessionId, reply, proposalId }), undefined);
      });
    });
  },
};
