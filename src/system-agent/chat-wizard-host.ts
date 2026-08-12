import type {
  SystemAgentChatQuestion,
  SystemAgentWizardCancel,
  WizardAnswer,
  WizardStep as ProtocolWizardStep,
} from "../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  sanitizeWizardStepForClient,
  WizardSession,
  wizardStepAwaitsInput,
  type WizardStep,
} from "../wizard/session.js";
import type { MemoryImportProviderOutcome } from "../wizard/setup.memory-import.js";
import {
  formatStructuredWizardAnswerForHistory,
  parseWizardAnswer,
  renderWizardStep,
  wizardStepChatQuestion,
} from "./chat-wizard-presentation.js";
import type { SystemAgentOperation } from "./operations.js";

type WizardPrompter = import("../wizard/prompts.js").WizardPrompter;
type HostedRuntime = typeof import("./hosted-setup.runtime.js");
type HostedSetupCompletion = import("./hosted-setup.runtime.js").HostedSetupCompletion;
type HostedMemoryImportOutcome = import("./hosted-setup.runtime.js").HostedMemoryImportOutcome;
type HostedWizardRunResult = void | HostedSetupCompletion | HostedMemoryImportOutcome;

type SystemAgentChatReplyAction = "none" | "exit" | "open-tui" | "open-setup";

export type SystemAgentChatReply = {
  text: string;
  action: SystemAgentChatReplyAction;
  agentDraft?: "hatch";
  sensitive?: boolean;
  wizardInputPending?: boolean;
  wizardSettling?: boolean;
  handoff?: SystemAgentOperation;
  question?: SystemAgentChatQuestion;
  step?: ProtocolWizardStep;
};

export type ChatWizardResult = {
  text: string;
  configWritten: boolean;
  sensitiveChannel?: string;
};

export type ChatWizardAnswerResult = ChatWizardResult & {
  userHistoryText: string;
};

export type ChatWizardHostDependencies = {
  runChannelSetupWizard?: (
    channel: string,
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
    abortSignal: AbortSignal,
  ) => Promise<void | HostedSetupCompletion>;
  runSkillsSetupWizard?: (
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  ) => Promise<void | HostedSetupCompletion>;
  runSearchSetupWizard?: (
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  ) => Promise<void | HostedSetupCompletion>;
  runGatewaySetupWizard?: (
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  ) => Promise<void | HostedSetupCompletion>;
  runMemoryImportWizard?: (
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
    onProviderOutcome: (outcome: MemoryImportProviderOutcome) => void,
  ) => Promise<HostedMemoryImportOutcome>;
  appendAuditEntry?: typeof import("./audit.js").appendSystemAgentAuditEntry;
};

type ActiveWizardBridge = {
  session: WizardSession;
  step: WizardStep | null;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  expiryKind: "presentation" | "cancellation" | undefined;
  qrExpiresAtMs: number | undefined;
  qrStepId: string | undefined;
  passiveQrStepId: string | undefined;
  qrExpired: boolean;
  kind: "channel" | "skills" | "search" | "gateway" | "memory-import";
  label: string;
  completion: {
    status: HostedSetupCompletion;
    memoryImport?: HostedMemoryImportOutcome;
    memoryImportProviders?: MemoryImportProviderOutcome[];
  };
  autoSelectChannel?: string;
};

const log = createSubsystemLogger("system-agent/chat-wizard-host");
export const SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS = 25 * 60 * 1000;
const WIZARD_CANCEL_HINT = "Say `cancel` to stop this setup.";
const WIZARD_QR_EXPIRED_MESSAGE =
  "This setup QR code expired. Setup is still finishing the attempt automatically.";
let hostedRuntimePromise: Promise<HostedRuntime> | undefined;

function loadHostedRuntime(): Promise<HostedRuntime> {
  return (hostedRuntimePromise ??= import("./hosted-setup.runtime.js"));
}

export class SystemAgentWizardAnswerError extends Error {}

export class ChatWizardHost {
  private bridge: ActiveWizardBridge | null = null;

  constructor(
    private readonly options: {
      surface?: "cli" | "gateway";
      supportsQrCode?: boolean;
      assertActive?: () => void;
      beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>;
      dependencies?: ChatWizardHostDependencies;
    },
  ) {}

  get active(): boolean {
    return this.bridge !== null;
  }

  get sensitiveInputPending(): boolean {
    return this.bridge?.step?.sensitive === true;
  }

  /** A QR-owning wizard stays protected until its terminal result is collected. */
  hasPendingQrCode(): boolean {
    return this.bridge?.passiveQrStepId !== undefined;
  }

  whenSettled(): Promise<void> | null {
    return this.bridge?.session.whenSettled() ?? null;
  }

  dispose(): Promise<void> {
    const settlement = this.bridge?.session.whenSettled() ?? Promise.resolve();
    this.clearBridge(true);
    return settlement;
  }

  decorateReply(reply: SystemAgentChatReply): SystemAgentChatReply {
    this.expireActiveQrIfNeeded();
    const step = this.bridge?.step ?? null;
    const projectedReply =
      this.bridge?.qrExpired === true && this.bridge.session.hasExternalQrPresentationOwner()
        ? { ...reply, text: WIZARD_QR_EXPIRED_MESSAGE }
        : reply;
    const completedReply =
      projectedReply.text && step && step.type !== "qr" && wizardStepAwaitsInput(step)
        ? { ...projectedReply, text: `${projectedReply.text}\n${WIZARD_CANCEL_HINT}` }
        : projectedReply;
    const question = wizardStepChatQuestion(step);
    const clientStep = step
      ? sanitizeWizardStepForClient(
          step,
          step.type === "qr" && this.bridge?.qrExpiresAtMs !== undefined
            ? Math.max(0, this.bridge.qrExpiresAtMs - Date.now())
            : undefined,
        )
      : null;
    const wizardInputPending = step ? wizardStepAwaitsInput(step) : false;
    const wizardSettling =
      this.bridge !== null &&
      (step === null || step.type === "qr") &&
      this.bridge.session.hasExternalQrPresentationOwner();
    return {
      ...completedReply,
      ...(step?.sensitive === true ? { sensitive: true } : {}),
      ...(wizardInputPending ? { wizardInputPending: true } : {}),
      ...(wizardSettling ? { wizardSettling: true } : {}),
      ...(question ? { question } : {}),
      ...(clientStep ? { step: clientStep } : {}),
    };
  }

  async answer(answer: WizardAnswer): Promise<ChatWizardAnswerResult> {
    this.expireActiveQrIfNeeded();
    const bridge = this.bridge;
    const step = bridge?.step;
    if (!bridge || !step) {
      throw new SystemAgentWizardAnswerError("No hosted wizard is awaiting an answer.");
    }
    if (answer.stepId !== step.id) {
      throw new SystemAgentWizardAnswerError("The hosted wizard answer targets a stale step.");
    }
    if (step.type === "qr") {
      throw new SystemAgentWizardAnswerError(
        "QR setup continues automatically; use wizardCancel to stop it.",
      );
    }
    if (!bridge.session.hasOwnedQrPresentation()) {
      this.clearExpiry(bridge);
    }
    bridge.step = null;
    const validationError = await bridge.session.answer(step.id, answer.value);
    if (validationError) {
      bridge.step = step;
    }
    const result = validationError
      ? { text: [validationError, renderWizardStep(step)].join("\n\n"), configWritten: false }
      : (this.renderPendingQrOwner(bridge) ?? (await this.pump()));
    return {
      ...result,
      userHistoryText: formatStructuredWizardAnswerForHistory(step, answer.value),
    };
  }

  async cancel(cancel: SystemAgentWizardCancel): Promise<ChatWizardAnswerResult> {
    const bridge = this.bridge;
    const step = bridge?.step;
    if (!bridge) {
      throw new SystemAgentWizardAnswerError("No hosted wizard is awaiting cancellation.");
    }
    const targetsSettlingQr =
      step === null &&
      bridge.qrStepId === cancel.stepId &&
      bridge.session.hasExternalQrPresentationOwner();
    if (cancel.stepId !== step?.id && !targetsSettlingQr) {
      throw new SystemAgentWizardAnswerError("The hosted wizard cancel targets a stale step.");
    }
    if (!bridge.session.cancel()) {
      throw new SystemAgentWizardAnswerError("The hosted wizard cannot be cancelled right now.");
    }
    await bridge.session.whenSettled();
    return { ...(await this.pump()), userHistoryText: "Cancel" };
  }

  /** Observe a QR-owned step without answering the dependency-owned prompt. */
  async pollStep(stepId: string): Promise<ChatWizardResult> {
    this.expireActiveQrIfNeeded();
    const bridge = this.bridge;
    if (!bridge) {
      throw new SystemAgentWizardAnswerError("The hosted wizard step is no longer active.");
    }
    if (bridge.step?.id === stepId) {
      return { text: renderWizardStep(bridge.step), configWritten: false };
    }
    if (bridge.passiveQrStepId !== stepId) {
      throw new SystemAgentWizardAnswerError("The hosted wizard poll targets a stale step.");
    }
    return this.renderPendingQrOwner(bridge) ?? (await this.pump());
  }

  async resolveReply(text: string): Promise<ChatWizardResult | null> {
    const bridge = this.bridge;
    if (!bridge) {
      return { text: "", configWritten: false };
    }
    if (/^(cancel|abort|stop|quit|exit)$/i.test(text.trim())) {
      bridge.session.cancel();
      await bridge.session.whenSettled();
      return await this.pump();
    }
    this.expireActiveQrIfNeeded();
    if (bridge.qrExpired) {
      if (bridge.session.hasExternalQrPresentationOwner()) {
        return {
          text: WIZARD_QR_EXPIRED_MESSAGE,
          configWritten: false,
        };
      }
      // The timeout may abort the QR presentation before the setup runner finishes
      // unwinding. Keep ordinary turns behind that owner so cleanup cannot race them.
      await bridge.session.whenSettled();
      this.clearBridge();
      return null;
    }
    const step = bridge.step;
    if (!step) {
      return this.renderPendingQrOwner(bridge) ?? (await this.pump());
    }
    if (step.type === "qr") {
      return {
        text: "Scan the QR code and approve the device. Setup continues automatically; say `cancel` to stop it.",
        configWritten: false,
      };
    }
    const answer = parseWizardAnswer(step, text);
    if (!answer) {
      return {
        text: ["I could not match that answer.", renderWizardStep(step)].join("\n"),
        configWritten: false,
      };
    }
    if (!bridge.session.hasOwnedQrPresentation()) {
      this.clearExpiry(bridge);
    }
    bridge.step = null;
    const validationError = await bridge.session.answer(step.id, answer.value);
    if (validationError) {
      bridge.step = step;
      return { text: [validationError, renderWizardStep(step)].join("\n\n"), configWritten: false };
    }
    return this.renderPendingQrOwner(bridge) ?? (await this.pump());
  }

  async startChannel(channel: string): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runChannelSetupWizard;
    return await this.start({
      kind: "channel",
      label: channel,
      autoSelectChannel: channel,
      run: async (prompter, signal, beforePersistentApply) =>
        run
          ? await run(channel, prompter, beforePersistentApply, signal)
          : await (
              await loadHostedRuntime()
            ).runHostedChannelSetup(channel, prompter, beforePersistentApply, signal),
    });
  }

  async startSkills(): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runSkillsSetupWizard;
    return await this.start({
      kind: "skills",
      label: "skills",
      run: async (prompter, _signal, beforePersistentApply) =>
        run
          ? await run(prompter, beforePersistentApply)
          : await (await loadHostedRuntime()).runHostedSkillsSetup(prompter, beforePersistentApply),
    });
  }

  async startSearch(): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runSearchSetupWizard;
    return await this.start({
      kind: "search",
      label: "web search",
      run: async (prompter, _signal, beforePersistentApply) =>
        run
          ? await run(prompter, beforePersistentApply)
          : await (await loadHostedRuntime()).runHostedSearchSetup(prompter, beforePersistentApply),
    });
  }

  async startGateway(): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runGatewaySetupWizard;
    const result = await this.start({
      kind: "gateway",
      label: "gateway",
      run: async (prompter, _signal, beforePersistentApply) =>
        run
          ? await run(prompter, beforePersistentApply)
          : await (
              await loadHostedRuntime()
            ).runHostedGatewaySetup(prompter, beforePersistentApply),
    });
    if (this.options.surface !== "gateway" || !this.bridge) {
      return result;
    }
    const warning = [
      "Before we start: changing the Gateway port, bind address, or auth credential requires a Gateway restart to apply.",
      "That restart may disconnect this chat, and you may need to sign in to the Control UI again with the new address or credential.",
    ].join(" ");
    return { ...result, text: [warning, result.text].filter(Boolean).join("\n\n") };
  }

  async startMemoryImport(): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runMemoryImportWizard;
    const providers: MemoryImportProviderOutcome[] = [];
    return await this.start({
      kind: "memory-import",
      label: "memory import",
      memoryImportProviders: providers,
      run: async (prompter, _signal, beforePersistentApply) =>
        run
          ? await run(prompter, beforePersistentApply, (value) => providers.push(value))
          : await (
              await loadHostedRuntime()
            ).runHostedMemoryImport(prompter, beforePersistentApply, (value) =>
              providers.push(value),
            ),
    });
  }

  private async start(params: {
    kind: ActiveWizardBridge["kind"];
    label: string;
    autoSelectChannel?: string;
    memoryImportProviders?: MemoryImportProviderOutcome[];
    run: (
      prompter: WizardPrompter,
      signal: AbortSignal,
      beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
    ) => Promise<HostedWizardRunResult>;
  }): Promise<ChatWizardResult> {
    this.options.assertActive?.();
    const completion: ActiveWizardBridge["completion"] = {
      status: "applied",
      ...(params.memoryImportProviders
        ? { memoryImportProviders: params.memoryImportProviders }
        : {}),
    };
    const session = new WizardSession(
      async (prompter, signal, runnerSession) => {
        const beforePersistentApply = async (runtime: RuntimeEnv) => {
          signal.throwIfAborted();
          await this.options.beforePersistentApply(runtime);
          signal.throwIfAborted();
          // Once a durable effect starts, its truthful result must win over a late cancel.
          runnerSession.lockCancellation();
        };
        const result = await params.run(prompter, signal, beforePersistentApply);
        if (typeof result === "string") {
          completion.status = result;
        } else if (result) {
          completion.memoryImport = result;
        }
      },
      {
        supportsQrCode: this.options.supportsQrCode === true,
        onQrPresentationOwnerSettled: (stepId) => {
          const activeBridge = this.bridge;
          if (activeBridge?.session === session) {
            this.handleQrOwnerDismissal(activeBridge, stepId);
          }
        },
      },
    );
    this.bridge = {
      session,
      step: null,
      expiryTimer: undefined,
      expiryKind: undefined,
      qrExpiresAtMs: undefined,
      qrStepId: undefined,
      passiveQrStepId: undefined,
      qrExpired: false,
      kind: params.kind,
      label: params.label,
      completion,
      ...(params.autoSelectChannel ? { autoSelectChannel: params.autoSelectChannel } : {}),
    };
    return await this.pump();
  }

  private tryAutoSelect(step: WizardStep): { value: unknown } | null {
    const bridge = this.bridge;
    const channel = bridge?.autoSelectChannel;
    if (!bridge || !channel || (step.type !== "select" && step.type !== "multiselect")) {
      return null;
    }
    const match = (step.options ?? []).find(
      (option) => typeof option.value === "string" && option.value.toLowerCase() === channel,
    );
    if (!match) {
      return null;
    }
    bridge.autoSelectChannel = undefined;
    return { value: step.type === "multiselect" ? [match.value] : match.value };
  }

  private clearExpiry(bridge: ActiveWizardBridge): void {
    if (bridge.expiryTimer) {
      clearTimeout(bridge.expiryTimer);
      bridge.expiryTimer = undefined;
    }
    bridge.expiryKind = undefined;
    bridge.qrExpiresAtMs = undefined;
    bridge.qrStepId = undefined;
  }

  private armQrExpiry(bridge: ActiveWizardBridge): void {
    this.clearExpiry(bridge);
    bridge.qrExpired = false;
    const abandonmentExpiresAtMs = Date.now() + SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS;
    const ownerExpiresAtMs = bridge.step?.type === "qr" ? bridge.step.qrExpiresAtMs : undefined;
    bridge.qrExpiresAtMs =
      ownerExpiresAtMs === undefined
        ? abandonmentExpiresAtMs
        : Math.min(ownerExpiresAtMs, abandonmentExpiresAtMs);
    bridge.expiryKind =
      ownerExpiresAtMs !== undefined &&
      ownerExpiresAtMs <= abandonmentExpiresAtMs &&
      bridge.session.hasExternalQrPresentationOwner()
        ? "presentation"
        : "cancellation";
    bridge.qrStepId = bridge.step?.id;
    bridge.passiveQrStepId = bridge.step?.id;
    const expiresAtMs = bridge.qrExpiresAtMs;
    bridge.expiryTimer = setTimeout(
      () => this.expireQr(bridge, expiresAtMs),
      Math.max(0, expiresAtMs - Date.now()),
    );
    bridge.expiryTimer.unref?.();
  }

  private handleQrOwnerDismissal(bridge: ActiveWizardBridge, stepId: string): void {
    if (this.bridge !== bridge || bridge.qrStepId !== stepId) {
      return;
    }
    // The credential owner has a truthful result, but its runner may still be applying it.
    // Retire the stale QR and replace its credential deadline with bounded runner ownership.
    if (bridge.step?.id === stepId) {
      bridge.step = null;
    }
    bridge.qrExpired = false;
    if (bridge.step) {
      this.clearExpiry(bridge);
      return;
    }
    this.armRunnerExpiry(bridge, stepId);
  }

  private armRunnerExpiry(bridge: ActiveWizardBridge, stepId: string): void {
    this.clearExpiry(bridge);
    const expiresAtMs = Date.now() + SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS;
    bridge.qrExpiresAtMs = expiresAtMs;
    bridge.expiryKind = "cancellation";
    bridge.qrStepId = stepId;
    bridge.expiryTimer = setTimeout(
      () => this.expireQr(bridge, expiresAtMs),
      SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS,
    );
    bridge.expiryTimer.unref?.();
    void bridge.session.whenSettled().then(() => {
      if (this.bridge === bridge && bridge.qrExpiresAtMs === expiresAtMs) {
        this.clearExpiry(bridge);
      }
    });
  }

  private expireQr(bridge: ActiveWizardBridge, expectedExpiresAtMs = bridge.qrExpiresAtMs): void {
    if (
      this.bridge !== bridge ||
      expectedExpiresAtMs === undefined ||
      bridge.qrExpiresAtMs !== expectedExpiresAtMs
    ) {
      return;
    }
    if (
      bridge.expiryKind === "presentation" &&
      bridge.qrStepId !== undefined &&
      bridge.session.hasExternalQrPresentationOwner()
    ) {
      const stepId = bridge.qrStepId;
      bridge.qrExpired = bridge.session.expireOwnedQrPresentation(stepId);
      bridge.step = null;
      this.armRunnerExpiry(bridge, stepId);
      return;
    }
    bridge.session.cancel();
    // Keep a scrubbed marker until the next queued turn observes expiry.
    bridge.qrExpired = true;
    this.clearExpiry(bridge);
    bridge.step = null;
  }

  private expireActiveQrIfNeeded(): void {
    const bridge = this.bridge;
    if (bridge?.qrExpiresAtMs !== undefined && Date.now() >= bridge.qrExpiresAtMs) {
      this.expireQr(bridge);
    }
  }

  private clearBridge(cancelSession = false): void {
    const bridge = this.bridge;
    if (!bridge) {
      return;
    }
    if (cancelSession) {
      bridge.session.cancel();
    }
    this.clearExpiry(bridge);
    this.bridge = null;
  }

  private renderPendingQrOwner(bridge: ActiveWizardBridge): ChatWizardResult | null {
    if (!bridge.session.hasExternalQrPresentationOwner()) {
      return null;
    }
    return {
      text: "Setup is still finishing this QR operation. Say `cancel` to stop it.",
      configWritten: false,
    };
  }

  private async pump(): Promise<ChatWizardResult> {
    const bridge = this.bridge;
    if (!bridge) {
      return { text: "", configWritten: false };
    }
    const result = await bridge.session.next();
    if (result.done) {
      this.clearBridge();
      const label = bridge.label;
      if (result.status === "done") {
        if (bridge.kind === "memory-import") {
          try {
            return {
              text: await (
                await loadHostedRuntime()
              ).renderMemoryImport(
                bridge.completion.memoryImport,
                this.options.dependencies?.appendAuditEntry,
              ),
              configWritten: false,
            };
          } catch (error) {
            log.warn(`memory import completed without audit entry: ${formatErrorMessage(error)}`);
            return {
              text: await (
                await loadHostedRuntime()
              ).renderMemoryImport(bridge.completion.memoryImport, async () => ""),
              configWritten: false,
            };
          }
        }
        if (bridge.completion.status === "kept-current") {
          return {
            text: `${label[0]?.toUpperCase() ?? "S"}${label.slice(1)} setup kept the current configuration. Nothing was changed.`,
            configWritten: false,
          };
        }
        await this.auditSetup(bridge);
        const success =
          bridge.kind === "channel"
            ? [
                `Done — ${label} is configured.`,
                "Say `restart gateway` to apply channel changes, or `channels` to review.",
              ]
            : bridge.kind === "skills"
              ? ["Done — skills dependency setup is complete."]
              : bridge.kind === "search"
                ? [
                    "Done — web search setup is complete.",
                    "Restart the Gateway if the selected provider or plugin changed.",
                  ]
                : [
                    "Done — gateway settings saved.",
                    "Restart the Gateway to apply them (`restart gateway`).",
                  ];
        return { text: success.join("\n"), configWritten: true };
      }
      if (bridge.kind === "memory-import") {
        try {
          await (
            await loadHostedRuntime()
          ).auditMemoryImport(
            bridge.completion.memoryImportProviders ?? [],
            this.options.dependencies?.appendAuditEntry,
          );
        } catch (error) {
          log.warn(`memory import completed without audit entry: ${formatErrorMessage(error)}`);
        }
      }
      if (result.status === "cancelled") {
        return {
          text: `${label[0]?.toUpperCase() ?? "S"}${label.slice(1)} setup cancelled. Nothing was changed beyond completed steps.`,
          configWritten: false,
        };
      }
      return {
        text: `${label[0]?.toUpperCase() ?? "S"}${label.slice(1)} setup stopped: ${result.error ?? "unknown error"}`,
        configWritten: false,
      };
    }
    bridge.step = result.step ?? null;
    if (!bridge.session.hasExternalQrPresentationOwner()) {
      this.clearExpiry(bridge);
    }
    if (bridge.step?.qrDataUrl) {
      this.armQrExpiry(bridge);
    }
    if (bridge.step) {
      const auto = this.tryAutoSelect(bridge.step);
      if (auto) {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, auto.value);
        return await this.pump();
      }
      if (this.options.surface === "cli" && bridge.step.sensitive === true) {
        bridge.session.cancel();
        this.clearBridge();
        const target =
          bridge.kind === "channel"
            ? `Say \`open channel wizard\` and I'll hand you to the masked terminal wizard for ${bridge.label}, or run \`openclaw channels add --channel ${bridge.label}\` yourself later.`
            : bridge.kind === "gateway"
              ? "Say `open gateway wizard` and I'll hand you to the masked terminal wizard, or run `openclaw configure --section gateway` yourself later."
              : "Say `open search wizard` and I'll hand you to the masked terminal wizard, or run `openclaw configure --section web` yourself later.";
        return {
          text: [
            "Sensitive input is not accepted in the OpenClaw chat because terminal input is visible.",
            target,
          ].join("\n"),
          configWritten: false,
          ...(bridge.kind === "channel" ? { sensitiveChannel: bridge.label } : {}),
        };
      }
      if (bridge.step.type === "note" || bridge.step.type === "progress") {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, undefined);
        const next = await this.pump();
        return { ...next, text: [renderWizardStep(step), next.text].filter(Boolean).join("\n\n") };
      }
      if (bridge.step.type === "action" && bridge.step.executor !== "client") {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, true);
        return await this.pump();
      }
    }
    return { text: bridge.step ? renderWizardStep(bridge.step) : "", configWritten: false };
  }

  private async auditSetup(bridge: ActiveWizardBridge): Promise<void> {
    const entry =
      bridge.kind === "channel"
        ? {
            operation: "channels.setup",
            summary: `Configured channel ${bridge.label} via chat setup`,
            details: { channel: bridge.label },
          }
        : bridge.kind === "skills"
          ? {
              operation: "skills.setup",
              summary: "Completed skills dependency setup via chat",
              details: { capability: "skills" },
            }
          : bridge.kind === "search"
            ? {
                operation: "search.setup",
                summary: "Configured web search via chat setup",
                details: { capability: "web-search" },
              }
            : {
                operation: "gateway.setup",
                summary: "Configured Gateway via chat setup",
                details: { capability: "gateway" },
              };
    try {
      const append =
        this.options.dependencies?.appendAuditEntry ??
        (await import("./audit.js")).appendSystemAgentAuditEntry;
      await append(entry);
    } catch (error) {
      log.warn(`${bridge.kind} setup completed without audit entry: ${formatErrorMessage(error)}`);
    }
  }
}
