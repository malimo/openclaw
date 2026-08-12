// OpenClaw chat engine: stable transport-agnostic facade over turn and wizard owners.
import type {
  SystemAgentWizardCancel,
  WizardAnswer,
} from "../../packages/gateway-protocol/src/index.js";
import type { RuntimeEnv } from "../runtime.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import {
  cleanupSystemAgentSession,
  createSystemAgentSession,
  type SystemAgentSession,
  type SystemAgentTurnRunner,
} from "./agent-turn.js";
import type { SystemAgentApprovalClassifier } from "./approval-intent.js";
import type { SystemAgentAssistantPlanner, SystemAgentAssistantTurn } from "./assistant.js";
import {
  ChatTurnRouter,
  redactSensitiveCommandText,
  type SystemAgentChatTurnOptions,
} from "./chat-turn-router.js";
import {
  ChatWizardHost,
  SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS,
  type ChatWizardHostDependencies,
  type SystemAgentChatReply,
} from "./chat-wizard-host.js";
import type {
  SystemAgentGreetingFacts,
  SystemAgentGreetingPlan,
  SystemAgentGreetingPlanner,
} from "./greeting.js";
import {
  SystemAgentInferenceUnavailableError,
  isSystemAgentInferenceUnavailableError,
} from "./inference-error.js";
import type { SystemAgentCommandDeps, SystemAgentOperation } from "./operations.js";
import { loadSystemAgentOverview, type SystemAgentOverview } from "./overview.js";
import { verifyConfigAfterSystemAgentWrite } from "./post-write-verification.js";
import {
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
} from "./verified-inference.js";

export { SystemAgentWizardAnswerError } from "./chat-wizard-host.js";

export type SystemAgentChatEngineOptions = {
  yes?: boolean;
  deps?: SystemAgentCommandDeps;
  planWithAssistant?: SystemAgentAssistantPlanner;
  planGreeting?: SystemAgentGreetingPlanner;
  runAgentTurn?: SystemAgentTurnRunner;
  classifyApproval?: SystemAgentApprovalClassifier;
  surface?: "cli" | "gateway";
  supportsQrCode?: boolean;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  operatorApprovalOnly?: boolean;
};

type RetainedPollReply = {
  expiresAtMs: number;
  terminalHistoryRecorded: boolean;
  reply: SystemAgentChatReply;
};

function isTerminalPollReply(reply: SystemAgentChatReply): boolean {
  return (
    reply.step === undefined && reply.wizardInputPending !== true && reply.wizardSettling !== true
  );
}

type SystemAgentChatEngineInternals = {
  wizardDependencies?: ChatWizardHostDependencies;
  executeOperation?: typeof import("./operations.js").executeSystemAgentOperation;
};

/**
 * One conversation with OpenClaw, independent of transport. The facade owns
 * serialization, history, and the verified inference session; concept owners
 * route turns and host setup wizards behind the stable public entrypoint.
 */
export class SystemAgentChatEngine {
  private readonly history: SystemAgentAssistantTurn[] = [];
  private readonly agentSession: SystemAgentSession;
  private readonly wizard: ChatWizardHost;
  private readonly router: ChatTurnRouter;
  private verifiedInference: SystemAgentVerifiedInferenceBinding;
  private turnQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private persistentApplySettlement: Promise<void> | null = null;
  // Passive QR retries share one queued observation. Follow-ups remain until
  // the wizard advances; terminal replies retain their recovery lease but
  // reserve QR capacity only until a request records their delivery.
  private retainedPollReplies = new Map<string, RetainedPollReply>();
  private passivePollObservations = new Map<string, Promise<SystemAgentChatReply>>();

  constructor(
    private readonly options: SystemAgentChatEngineOptions,
    internals: SystemAgentChatEngineInternals = {},
  ) {
    const binding = options?.verifiedInference;
    if (!binding) {
      throw new SystemAgentInferenceUnavailableError("conversation");
    }
    this.verifiedInference = binding;
    this.agentSession = createSystemAgentSession(binding);
    this.wizard = new ChatWizardHost({
      surface: options.surface,
      supportsQrCode: options.supportsQrCode,
      assertActive: () => this.assertActive(),
      beforePersistentApply: async (runtime) => {
        await this.requirePersistentApplyInference(runtime);
      },
      dependencies: internals.wizardDependencies,
    });
    this.router = new ChatTurnRouter(
      options,
      { executeOperation: internals.executeOperation },
      this.agentSession,
      this.wizard,
      {
        requireVerifiedInference: async () => await this.requireVerifiedInference(),
        requirePersistentApplyInference: async (runtime) =>
          await this.requirePersistentApplyInference(runtime),
        rebindVerifiedInference: (next) => this.rebindVerifiedInference(next),
        getVerifiedInference: () => this.verifiedInference,
        loadOverview: async () => await this.loadOverview(),
        getHistory: () => this.history,
        verifyConfigAfterWrite: async () => await this.verifyConfigAfterWrite(),
      },
    );
  }

  propose(operation: SystemAgentOperation): string {
    return this.router.propose(operation);
  }

  hasPendingProposal(): boolean {
    return this.router.hasPendingProposal();
  }

  hasPendingQrCode(): boolean {
    this.pruneExpiredPollReplies();
    return (
      this.wizard.hasPendingQrCode() ||
      this.passivePollObservations.size > 0 ||
      [...this.retainedPollReplies.values()].some(
        ({ reply, terminalHistoryRecorded }) =>
          isTerminalPollReply(reply) && !terminalHistoryRecorded,
      )
    );
  }

  /** Every reply retained under the original QR poll id is a live recovery lease. */
  hasRecoverableQrReply(): boolean {
    this.pruneExpiredPollReplies();
    return [...this.retainedPollReplies.values()].some(
      ({ reply, terminalHistoryRecorded }) =>
        !isTerminalPollReply(reply) || terminalHistoryRecorded,
    );
  }

  getPersistentApplySettlement(): Promise<void> | null {
    return this.persistentApplySettlement;
  }

  getPendingOperatorProposal(): { operation: SystemAgentOperation; hash: string } | null {
    return this.router.getPendingOperatorProposal();
  }

  async resolveOperatorApproval(
    decision: "allow-once" | "allow-always" | "deny" | null,
    proposalHash: string,
  ): Promise<SystemAgentChatReply | null> {
    this.assertActive();
    const turn = this.turnQueue.then(async () => {
      this.assertActive();
      const reply = await this.router.resolveOperatorApproval(decision, proposalHash);
      this.assertActive();
      if (reply?.text) {
        this.history.push({ role: "assistant", text: reply.text });
      }
      return reply;
    });
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  noteAssistantMessage(text: string): void {
    this.history.push({ role: "assistant", text });
  }

  seedHistory(turns: readonly SystemAgentAssistantTurn[]): void {
    this.history.push(
      ...turns.map((turn) => ({
        ...turn,
        text: turn.role === "user" ? redactSensitiveCommandText(turn.text) : turn.text,
      })),
    );
  }

  historyLength(): number {
    return this.history.length;
  }

  historySince(index: number): SystemAgentAssistantTurn[] {
    return this.history.slice(index).map((turn) => ({ role: turn.role, text: turn.text }));
  }

  async dispose(): Promise<void> {
    const wizardSettlement = this.wizard.whenSettled();
    if (!this.disposed) {
      this.disposed = true;
      this.router.clearForInferenceLoss();
      this.retainedPollReplies.clear();
      void this.wizard.dispose();
    }
    this.disposal ??= (async () => {
      try {
        await this.turnQueue;
        await wizardSettlement;
        await cleanupSystemAgentSession(this.agentSession);
      } finally {
        this.passivePollObservations.clear();
        this.retainedPollReplies.clear();
      }
    })();
    await this.disposal;
  }

  async handle(text: string, options?: SystemAgentChatTurnOptions): Promise<SystemAgentChatReply> {
    this.assertActive();
    const turn = this.turnQueue.then(async () => {
      this.assertActive();
      await this.requireVerifiedInference();
      const sensitiveTurn = this.wizard.sensitiveInputPending;
      const reply = await this.router.resolveTurn(text, options);
      this.assertActive();
      return this.completeTurn(
        reply,
        sensitiveTurn ? "<redacted secret>" : redactSensitiveCommandText(text),
      );
    });
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  /** Observe a passive wizard step while keeping its continuation in the turn queue. */
  async pollStep(stepId: string): Promise<SystemAgentChatReply> {
    this.assertActive();
    this.pruneExpiredPollReplies();
    if (!this.retainedPollReplies.has(stepId) && !this.passivePollObservations.has(stepId)) {
      this.wizard.assertPollableStep(stepId);
    }
    const observation = getOrCreatePromise(
      this.passivePollObservations,
      stepId,
      () => {
        const turn = this.turnQueue.then(async () => {
          this.assertActive();
          this.pruneExpiredPollReplies();
          const queuedRetained = this.retainedPollReplies.get(stepId);
          if (queuedRetained) {
            return { ...queuedRetained.reply };
          }
          const result = await this.router.finalizeWizardResult(await this.wizard.pollStep(stepId));
          this.assertActive();
          const reply = this.wizard.decorateReply({ text: result.text, action: "none" });
          if (reply.wizardSettling !== true) {
            this.retainedPollReplies.set(stepId, {
              expiresAtMs:
                result.passiveQrRetentionExpiresAtMs ??
                Date.now() + SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS,
              terminalHistoryRecorded: false,
              reply: { ...reply },
            });
          }
          return reply;
        });
        this.turnQueue = turn.catch(() => undefined);
        return turn;
      },
      { evictOnSettled: true },
    );
    let cancelTimer: (() => void) | undefined;
    const outcome = await Promise.race([
      observation.then((reply) => ({ reply })),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 0);
        cancelTimer = () => clearTimeout(timer);
      }),
    ]);
    cancelTimer?.();
    if (outcome) {
      const retained = this.retainedPollReplies.get(stepId);
      if (retained) {
        return this.recordObservedPollReply(retained);
      }
      return outcome.reply;
    }
    return {
      text: "Setup is still finishing this QR operation.",
      action: "none",
      wizardSettling: true,
    };
  }

  private recordObservedPollReply(retained: RetainedPollReply): SystemAgentChatReply {
    if (isTerminalPollReply(retained.reply) && !retained.terminalHistoryRecorded) {
      // Only the request that observes completion may make it durable. The
      // background observer can finish after its Gateway request has returned.
      retained.terminalHistoryRecorded = true;
      if (retained.reply.text) {
        this.history.push({ role: "assistant", text: retained.reply.text });
      }
    }
    return { ...retained.reply };
  }

  private pruneExpiredPollReplies(nowMs = Date.now()): void {
    for (const [stepId, retained] of this.retainedPollReplies) {
      if (retained.expiresAtMs <= nowMs) {
        this.retainedPollReplies.delete(stepId);
      }
    }
  }

  async answerWizard(answer: WizardAnswer): Promise<SystemAgentChatReply> {
    this.assertActive();
    const turn = this.turnQueue.then(async () => {
      this.assertActive();
      await this.requireVerifiedInference();
      const result = await this.router.answerWizard(this.wizard.answer(answer));
      this.assertActive();
      return this.completeTurn({ text: result.text, action: "none" }, result.userHistoryText);
    });
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  async cancelWizard(cancel: SystemAgentWizardCancel): Promise<SystemAgentChatReply> {
    this.assertActive();
    // Only an in-flight passive observation may be interrupted out of queue: it can
    // be waiting for the same runner that cancellation must release. Other turns
    // retain their accepted ordering on the single execution queue.
    const interruption = this.passivePollObservations.has(cancel.stepId)
      ? this.wizard.requestCancellation(cancel)
      : null;
    const turn = this.turnQueue.then(async () => {
      this.assertActive();
      const result = await this.router.answerWizard(
        interruption ? interruption.finish() : this.wizard.cancel(cancel),
      );
      this.assertActive();
      this.retainedPollReplies.delete(cancel.stepId);
      return this.completeTurn({ text: result.text, action: "none" }, result.userHistoryText);
    });
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  private completeTurn(reply: SystemAgentChatReply, userHistoryText: string): SystemAgentChatReply {
    const completed = this.wizard.decorateReply(reply);
    for (const [pollStepId, retained] of this.retainedPollReplies) {
      if (retained.reply.step?.id !== completed.step?.id) {
        this.retainedPollReplies.delete(pollStepId);
      }
    }
    this.history.push({ role: "user", text: userHistoryText });
    if (completed.text) {
      this.history.push({ role: "assistant", text: completed.text });
    }
    return completed;
  }

  async loadOverview(): Promise<SystemAgentOverview> {
    const route = await this.requireVerifiedInference();
    const overview = this.options.deps?.loadOverview
      ? await this.options.deps.loadOverview()
      : await loadSystemAgentOverview();
    return { ...overview, defaultModel: route.modelLabel };
  }

  async planGreeting(params: {
    overview: SystemAgentOverview;
    facts: SystemAgentGreetingFacts;
    timeoutMs: number;
  }): Promise<SystemAgentGreetingPlan | null> {
    const planner = this.options.planGreeting;
    const plan = planner
      ? await planner(params)
      : await import("./assistant.js").then(({ planSystemAgentGreetingWithConfiguredModel }) =>
          planSystemAgentGreetingWithConfiguredModel({
            ...params,
            verifiedInference: this.verifiedInference,
            deps: this.options.deps,
          }),
        );
    if (plan) {
      await this.requireVerifiedInference();
    }
    return plan;
  }

  private async requireVerifiedInference() {
    this.assertActive();
    const binding = this.verifiedInference;
    if (this.agentSession.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    try {
      const route = await resolveSystemAgentVerifiedInferenceRoute(binding, this.options.deps);
      if (route) {
        this.assertActive();
        return route;
      }
    } catch (error) {
      return this.throwInferenceUnavailable([error]);
    }
    return this.throwInferenceUnavailable();
  }

  private async requirePersistentApplyInference(runtime: RuntimeEnv) {
    this.assertActive();
    const binding = this.verifiedInference;
    if (this.agentSession.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    try {
      const { resolvePersistentApplyInference } = await import("./setup-inference.js");
      const route = await resolvePersistentApplyInference({
        binding,
        runtime,
        deps: this.options.deps,
      });
      if (route) {
        this.assertActive();
        const settlement = (this.wizard.whenSettled() ?? this.turnQueue).then(() => undefined);
        this.persistentApplySettlement = settlement;
        const clearSettlement = () => {
          if (this.persistentApplySettlement === settlement) {
            this.persistentApplySettlement = null;
          }
        };
        void settlement.then(clearSettlement, clearSettlement);
        return route;
      }
    } catch (error) {
      if (isSystemAgentInferenceUnavailableError(error)) {
        return this.throwInferenceUnavailable(error.failures, false);
      }
      return this.throwInferenceUnavailable([error], false);
    }
    return this.throwInferenceUnavailable([], false);
  }

  private rebindVerifiedInference(binding: SystemAgentVerifiedInferenceBinding): void {
    if (binding.execution.agentId !== this.verifiedInference.execution.agentId) {
      return;
    }
    delete this.agentSession.cliSession;
    this.verifiedInference = binding;
    this.agentSession.verifiedInference = binding;
  }

  private throwInferenceUnavailable(failures: readonly unknown[] = [], cancelWizard = true): never {
    this.router.clearForInferenceLoss();
    delete this.agentSession.cliSession;
    if (cancelWizard) {
      // Inference loss terminates the conversation. Start the aggregate owner
      // disposal now so later Gateway/TUI cleanup joins the producer settlement.
      void this.dispose().catch(() => undefined);
    }
    this.history.splice(0);
    throw new SystemAgentInferenceUnavailableError("conversation", failures);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("System-agent chat engine has been disposed.");
    }
  }

  private async verifyConfigAfterWrite(): Promise<string | null> {
    return await verifyConfigAfterSystemAgentWrite((message) =>
      this.router.resolveAssistantTurn(message, false),
    );
  }
}
