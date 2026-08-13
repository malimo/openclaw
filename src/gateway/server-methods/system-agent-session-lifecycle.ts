import { toErrorObject } from "../../infra/errors.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAdmittedWizardSession,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import type { GatewayRequestContext } from "./types.js";

type SystemAgentSessions = GatewayRequestContext["systemAgentSessions"];
type SystemAgentSession = SystemAgentSessions extends Map<string, infer Session> ? Session : never;
type WizardSessions = GatewayRequestContext["wizardSessions"];
type GatewayWizardSession = WizardSessions extends Map<string, infer Session> ? Session : never;
type ApprovalManager = NonNullable<GatewayRequestContext["systemAgentApprovalManager"]>;

export type DisplacedSystemAgentSession = {
  sessionId: string;
  session: SystemAgentSession;
  approvalManager?: ApprovalManager;
  reason: string;
};

const retiredStores = new WeakSet<SystemAgentSessions>();
const pendingSessionSettlements = new WeakMap<SystemAgentSessions, Set<Promise<void>>>();
const settledInitializationCleanupFailures = new WeakMap<SystemAgentSessions, Error[]>();
const retiredWizardStores = new WeakSet<WizardSessions>();
const pendingWizardAdmissions = new WeakMap<
  WizardSessions,
  Set<Promise<GatewayWizardSession | undefined>>
>();

export function assertSystemAgentSessionStoreActive(sessions: SystemAgentSessions): void {
  if (retiredStores.has(sessions)) {
    throw new Error("OpenClaw session owner is shutting down.");
  }
}

function trackSessionSettlement(
  sessions: SystemAgentSessions,
  settlement: Promise<void>,
): Promise<void> {
  let pending = pendingSessionSettlements.get(sessions);
  if (!pending) {
    pending = new Set();
    pendingSessionSettlements.set(sessions, pending);
  }
  pending.add(settlement);
  void settlement.finally(() => pending?.delete(settlement)).catch(() => undefined);
  return settlement;
}

/** Registers initialization before its first await and owns its engine until map commit. */
export function initializeSystemAgentSession(
  sessions: SystemAgentSessions,
  sessionId: string,
  initialize: (lease: {
    ownEngine: (engine: SystemAgentSession["engine"]) => void;
    commitSession: (
      session: SystemAgentSession,
      displaced?: DisplacedSystemAgentSession,
    ) => Promise<void> | undefined;
  }) => Promise<void>,
): Promise<SystemAgentSession | undefined> {
  assertSystemAgentSessionStoreActive(sessions);
  const settlement = createDeferredCore();
  void trackSessionSettlement(sessions, settlement.promise);
  let uncommittedEngine: SystemAgentSession["engine"] | undefined;
  let committedSession: SystemAgentSession | undefined;
  return (async () => {
    try {
      await initialize({
        ownEngine: (engine) => {
          uncommittedEngine = engine;
        },
        commitSession: (session, displaced) => {
          if (uncommittedEngine !== session.engine) {
            throw new Error("OpenClaw session initialization does not own this engine.");
          }
          assertSystemAgentSessionStoreActive(sessions);
          if (displaced) {
            if (displaced.sessionId === sessionId) {
              throw new Error("OpenClaw session replacement cannot displace itself.");
            }
            if (sessions.get(displaced.sessionId) !== displaced.session) {
              throw new Error("OpenClaw session replacement target changed before commit.");
            }
          }
          sessions.set(sessionId, session);
          // The map and lease never own the engine across an await; commit transfers it here.
          uncommittedEngine = undefined;
          committedSession = session;
          if (!displaced) {
            return undefined;
          }
          sessions.delete(displaced.sessionId);
          return startSystemAgentSessionCleanup({
            sessions,
            session: displaced.session,
            approvalManager: displaced.approvalManager,
            reason: displaced.reason,
            expireApproval: true,
          });
        },
      });
      return committedSession && sessions.get(sessionId) === committedSession
        ? committedSession
        : undefined;
    } finally {
      try {
        await uncommittedEngine?.dispose();
        settlement.resolve();
      } catch (error) {
        const cleanupError = toErrorObject(error, "Unknown system-agent cleanup failure");
        if (!retiredStores.has(sessions)) {
          const failures = settledInitializationCleanupFailures.get(sessions) ?? [];
          failures.push(cleanupError);
          settledInitializationCleanupFailures.set(sessions, failures);
        }
        // Retirement already snapshots an in-flight lease; only earlier failures need escrow.
        settlement.reject(cleanupError);
      }
    }
  })();
}

function settleCleanupTasks(
  tasks: Iterable<PromiseLike<unknown>>,
  describeFailure: (errorCount: number) => string,
): Promise<void> {
  return Promise.allSettled(tasks).then((results) => {
    const errors = results
      .flatMap((result) => {
        if (result.status !== "rejected") {
          return [];
        }
        return result.reason instanceof AggregateError ? result.reason.errors : [result.reason];
      })
      .map((error) => toErrorObject(error, "Unknown system-agent cleanup failure"));
    if (errors.length > 0) {
      const details = errors.map((error) => error.message).join("; ");
      throw new AggregateError(errors, `${describeFailure(errors.length)}: ${details}`);
    }
  });
}

function trackWizardAdmission(
  sessions: WizardSessions,
  admission: Promise<GatewayWizardSession | undefined>,
): Promise<GatewayWizardSession | undefined> {
  let pending = pendingWizardAdmissions.get(sessions);
  if (!pending) {
    pending = new Set();
    pendingWizardAdmissions.set(sessions, pending);
  }
  pending.add(admission);
  void admission.finally(() => pending?.delete(admission)).catch(() => undefined);
  return admission;
}

/** Admits and registers a runner atomically with respect to Gateway retirement. */
export function admitWizard(
  sessions: WizardSessions,
  sessionId: string,
  createSession: () => GatewayWizardSession,
  lockSetupTarget?: boolean,
): Promise<GatewayWizardSession | undefined> {
  if (retiredWizardStores.has(sessions)) {
    return Promise.resolve(undefined);
  }
  const admission = (async () => {
    const session = await createAdmittedWizardSession(createSession, lockSetupTarget);
    if (!session) {
      return undefined;
    }
    if (retiredWizardStores.has(sessions)) {
      session.cancel();
      await whenAdmittedWizardSessionSettled(session);
      return undefined;
    }
    sessions.set(sessionId, session);
    return session;
  })();
  return trackWizardAdmission(sessions, admission);
}

function startSystemAgentSessionCleanup(params: {
  sessions: SystemAgentSessions;
  session: SystemAgentSession;
  approvalManager?: ApprovalManager;
  reason: string;
  expireApproval: boolean;
}): Promise<void> {
  let engineDisposal: Promise<void>;
  try {
    engineDisposal = params.session.engine.dispose();
  } catch (error) {
    engineDisposal = Promise.reject(toErrorObject(error, "Unknown system-agent cleanup failure"));
  }
  let approvalExpiration: Promise<void> | undefined;
  if (params.expireApproval && params.session.pendingApproval && params.approvalManager) {
    try {
      params.approvalManager.expire(params.session.pendingApproval.id, params.reason);
      approvalExpiration = Promise.resolve();
    } catch (error) {
      // Durable-store faults stay asynchronous so one approval cannot skip sibling cleanup.
      approvalExpiration = Promise.reject(toErrorObject(error, "Unknown approval cleanup failure"));
    }
  }
  const cleanup = approvalExpiration
    ? settleCleanupTasks(
        [engineDisposal, approvalExpiration],
        (errorCount) => `Failed to clean up ${errorCount} OpenClaw session resource(s)`,
      )
    : engineDisposal;
  // Register only the aggregate in the same turn as removal/replacement so
  // shutdown joins cleanup without reporting one engine failure twice.
  return trackSessionSettlement(params.sessions, cleanup);
}

export function disposeSystemAgentSession(params: {
  sessions: SystemAgentSessions;
  sessionId: string;
  session: SystemAgentSession;
  approvalManager?: ApprovalManager;
  reason: string;
}): Promise<void> {
  const ownsEntry = params.sessions.get(params.sessionId) === params.session;
  if (ownsEntry) {
    params.sessions.delete(params.sessionId);
  }
  return startSystemAgentSessionCleanup({
    sessions: params.sessions,
    session: params.session,
    approvalManager: params.approvalManager,
    reason: params.reason,
    expireApproval: ownsEntry,
  });
}

export function disposeSystemAgentSessionsForOwner(params: {
  sessions: SystemAgentSessions;
  ownerKey: string;
  approvalManager?: ApprovalManager;
}): Promise<void> {
  const disposals: Promise<void>[] = [];
  for (const [sessionId, session] of params.sessions) {
    if (session.ownerKey !== params.ownerKey) {
      continue;
    }
    disposals.push(
      disposeSystemAgentSession({
        sessions: params.sessions,
        sessionId,
        session,
        approvalManager: params.approvalManager,
        reason: "session-owner-disconnected",
      }),
    );
  }
  const disposal = settleCleanupTasks(
    disposals,
    (errorCount) => `Failed to dispose ${errorCount} OpenClaw session(s)`,
  );
  return trackSessionSettlement(params.sessions, disposal);
}

export function retireAndDisposeSystemAgentSessions(params: {
  sessions: SystemAgentSessions;
  wizardSessions: WizardSessions;
  approvalManager?: ApprovalManager;
}): Promise<void> {
  retiredStores.add(params.sessions);
  retiredWizardStores.add(params.wizardSessions);
  const settledInitializationFailures =
    settledInitializationCleanupFailures.get(params.sessions) ?? [];
  settledInitializationCleanupFailures.delete(params.sessions);
  const disposals: Promise<unknown>[] = [
    ...(pendingSessionSettlements.get(params.sessions) ?? []),
    ...settledInitializationFailures.map((error) => Promise.reject(error)),
    ...(pendingWizardAdmissions.get(params.wizardSessions) ?? []),
  ];
  for (const [sessionId, session] of params.sessions) {
    disposals.push(
      disposeSystemAgentSession({
        sessions: params.sessions,
        sessionId,
        session,
        approvalManager: params.approvalManager,
        reason: "gateway-shutdown",
      }),
    );
  }
  for (const [sessionId, session] of params.wizardSessions) {
    params.wizardSessions.delete(sessionId);
    session.cancel();
    disposals.push(whenAdmittedWizardSessionSettled(session));
  }
  const disposal = settleCleanupTasks(
    disposals,
    (errorCount) => `Failed to settle ${errorCount} Gateway setup owner(s)`,
  );
  return trackSessionSettlement(params.sessions, disposal);
}
