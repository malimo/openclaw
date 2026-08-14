import {
  GATEWAY_SERVER_CAPS,
  type SystemAgentChatParams,
  type SystemAgentChatResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod, isGatewayCapabilityAdvertised } from "../../lib/gateway-methods.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import { pathForCustodianAgentHandoff } from "./custodian-navigation.ts";
import { CustodianQrSession } from "./custodian-qr-session.ts";
import {
  loadCustodianTranscriptProjection,
  projectCustodianChatResult,
  resolveCustodianSetupIssue,
} from "./custodian-session-request.ts";
import {
  hasCustodianUserInput,
  resetCustodianWizardState,
  resolveCustodianChatAccess,
  resolveCustodianConfiguredInferenceState,
  resolveCustodianSessionOwnershipKey,
  type CustodianConfiguredInferenceState,
} from "./custodian-session-state.ts";
import { custodianWizardSubmission } from "./custodian-wizard-step.ts";
import * as eventNudgeState from "./event-nudge.ts";
import {
  custodianChatParams,
  isCustodianSessionInvalidatedError,
  type CustodianSessionVariant,
} from "./session-lifecycle.ts";
import {
  createCustodianSessionId,
  custodianErrorMessage,
  hasUnresolvedCustodianQuestion,
  retireCustodianQuestions,
  type CustodianMessage,
} from "./transcript.ts";

const SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

type StoreListener = () => void;
type CustodianSetupIssue = "missing" | "unavailable";

/** One process-local conversation owner shared by the full page and dock surface. */
export class CustodianSessionStore {
  messages: CustodianMessage[] = [];
  input = "";
  sending = false;
  sensitive = false;
  wizardInputPending = false;
  wizardSettling = false;
  wizardValue: unknown;
  wizardSecretVisible = false;
  questionReplyUncertain = false;
  error: string | null = null;
  setupIssue: CustodianSetupIssue | null = null;
  dismissedQuestions = new Set<string>();
  answeredQuestions = new Set<string>();
  activeClient: GatewayBrowserClient | null = null;
  chatAvailable = false;
  eventNudge: eventNudgeState.CustodianEventNudge | null = null;
  eventNudgePending: eventNudgeState.CustodianEventNudge | null = null;
  channelOnboardingNudgeClosed = false;
  earlierBoundaryAfterId: number | null = null;
  abandonedTurnOutcomeUnknown = false;

  private context: ApplicationContext | null = null;
  private variant: CustodianSessionVariant = "caretaker";
  private sessionVariant: CustodianSessionVariant | null = null;
  private sessionId = createCustodianSessionId();
  private requestEpoch = 0;
  private requestAbort: AbortController | null = null;
  private nextMessageId = 1;
  private retryParams: SystemAgentChatParams | null = null;
  private sessionClient: GatewayBrowserClient | null = null;
  private sessionOwnershipKey: string | null = null;
  private sessionStarted = false;
  private configuredInferenceState: CustodianConfiguredInferenceState = "unresolved";
  private eventNudgeClosed = false;
  private gatewayCleanup: (() => void) | null = null;
  private agentCleanup: (() => void) | null = null;
  private eventCleanup: (() => void) | null = null;
  private readonly listeners = new Set<StoreListener>();
  private readonly qrSession = new CustodianQrSession(this, {
    emit: () => this.emit(),
    poll: (client, stepId, presentationGeneration) => {
      void this.requestReply(
        client,
        { sessionId: this.sessionId, pollStepId: stepId },
        { pollStepId: stepId, qrPresentationGeneration: presentationGeneration },
      );
    },
    invalidate: (client) => this.rotateVolatileSession(client, this.variant),
  });

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(context: ApplicationContext, variant: CustodianSessionVariant): void {
    const contextChanged = this.context !== context;
    const variantChanged = this.variant !== variant;
    if (!contextChanged && !variantChanged) {
      return;
    }
    if (contextChanged) {
      this.gatewayCleanup?.();
      this.agentCleanup?.();
      this.eventCleanup?.();
      this.context = context;
      this.gatewayCleanup = context.gateway.subscribe(() => {
        this.synchronizeClient();
        this.emit();
      });
      this.agentCleanup = context.agents.subscribe(() => {
        this.synchronizeClient();
        this.emit();
      });
      this.eventCleanup = context.gateway.subscribeEvents((event) => {
        if (this.variant !== "caretaker" || this.eventNudgeClosed) {
          return;
        }
        [this.eventNudge, this.eventNudgePending] = eventNudgeState.reconcileCustodianEventNudge(
          this.eventNudge,
          this.eventNudgePending,
          event,
        );
        this.emit();
      });
    }
    this.variant = variant;
    this.synchronizeClient();
    this.emit();
  }

  setInput(value: string): void {
    this.input = value;
    this.emit();
  }

  setWizardValue(value: unknown): void {
    this.wizardValue = value;
    this.emit();
  }

  toggleWizardSecretVisibility(): void {
    this.wizardSecretVisible = !this.wizardSecretVisible;
    this.emit();
  }

  hasRealUserTurn(): boolean {
    return this.messages.some((message) => message.role === "user");
  }

  get activeVariant(): CustodianSessionVariant {
    return this.variant;
  }

  hasUnresolvedQuestion(): boolean {
    return hasUnresolvedCustodianQuestion(
      this.messages,
      this.dismissedQuestions,
      this.answeredQuestions,
      this.wizardInputPending || this.wizardSettling,
      this.questionReplyUncertain,
    );
  }

  canRetry(): boolean {
    return this.retryParams !== null && !hasCustodianUserInput(this.retryParams);
  }

  get setupRequired(): boolean {
    return this.setupIssue !== null;
  }

  get wizardCancelAvailable(): boolean {
    return (
      isGatewayCapabilityAdvertised(
        this.context?.gateway.snapshot ?? {},
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL,
      ) ?? false
    );
  }

  retry(): void {
    const client = this.activeClient;
    const params = this.retryParams;
    if (client && params && !hasCustodianUserInput(params) && this.chatAvailable && !this.sending) {
      void this.initializeSession(client, params);
    }
  }

  async send(
    text = this.input,
    display?: string,
    questionReply = this.hasUnresolvedQuestion(),
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    // Trim decides emptiness only; sensitive values may carry meaningful whitespace.
    const message = this.sensitive ? text : text.trim();
    const client = this.activeClient;
    if (
      !message.trim() ||
      !client ||
      !this.chatAvailable ||
      this.sending ||
      this.setupRequired ||
      this.wizardInputPending ||
      this.wizardSettling
    ) {
      this.emit();
      return "rejected";
    }
    const displayText = this.sensitive ? t("custodian.sensitiveReply") : (display ?? message);
    return await this.sendUserTurn(
      client,
      {
        sessionId: this.sessionId,
        ...custodianChatParams(this.variant, message),
      },
      displayText,
      questionReply,
    );
  }

  private async sendUserTurn(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    displayText: string,
    questionReply: boolean,
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    const questionState = [this.answeredQuestions, this.questionReplyUncertain] as const;
    if (questionReply) {
      this.questionReplyUncertain = true;
    }
    this.abandonedTurnOutcomeUnknown = false;
    this.answeredQuestions = retireCustodianQuestions(this.messages, this.answeredQuestions);
    this.messages = [
      ...this.messages,
      {
        id: this.nextMessageId++,
        role: "user",
        text: displayText,
        at: Date.now(),
        question: null,
        step: null,
      },
    ];
    this.input = "";
    this.emit();
    const reply = this.requestReply(client, params);
    const replyEpoch = this.requestEpoch;
    const outcome = await reply;
    if (questionReply && this.requestEpoch === replyEpoch) {
      this.questionReplyUncertain = eventNudgeState.questionUncertainty(questionState[1], outcome);
      if (outcome === "rejected") {
        this.answeredQuestions = questionState[0];
      }
      this.emit();
    }
    return outcome;
  }

  async sendEventNudge(): Promise<void> {
    const nudge = this.eventNudge;
    if (!nudge || this.sensitive || this.hasUnresolvedQuestion()) {
      return;
    }
    this.eventNudgePending = nudge;
    this.emit();
    const outcome = await this.send(nudge.message);
    if (this.eventNudgePending === nudge) {
      this.eventNudgePending = null;
      const consumed = eventNudgeState.shouldConsumeNudge(this.eventNudge, nudge, outcome);
      [this.eventNudgeClosed, this.eventNudge] = [consumed, consumed ? null : this.eventNudge];
      this.emit();
    }
  }

  dismissEventNudge(): void {
    [this.eventNudge, this.eventNudgeClosed] = [null, true];
    this.emit();
  }

  dismissChannelOnboardingNudge(): void {
    this.channelOnboardingNudgeClosed = true;
    this.emit();
    this.context?.replace("custodian");
  }

  openChannelsFromOnboarding(): void {
    this.channelOnboardingNudgeClosed = true;
    this.revokeNavigationAuthority();
    this.emit();
    this.context?.navigate("channels");
  }

  async dismissQuestion(message: CustodianMessage): Promise<void> {
    const question = message.question;
    if (!question) {
      return;
    }
    if (question.skipAction === "exit") {
      this.exitSetup();
      return;
    }
    const outcome = await this.send(
      question.isOther ? t("optionCard.skip") : "cancel",
      t("optionCard.skip"),
      true,
    );
    if (outcome !== "rejected" && this.messages.includes(message)) {
      this.dismissedQuestions = new Set(this.dismissedQuestions).add(
        `${message.id}:${question.id}`,
      );
      this.emit();
    }
  }

  answerQuestion(message: CustodianMessage, label: string): void {
    const question = message.question;
    if (!question) {
      return;
    }
    const option = question.options.find((candidate) => candidate.label === label);
    void this.send(option?.reply ?? label, label, true);
  }

  answerWizardStep(message: CustodianMessage, value: unknown): void {
    const step = message.step;
    if (!step || !this.wizardInputPending) {
      return;
    }
    const submission = custodianWizardSubmission(step, value);
    const client = this.activeClient;
    if (!submission || !client || !this.chatAvailable || this.sending || this.setupRequired) {
      this.emit();
      return;
    }
    const displayText = step.sensitive ? t("custodian.sensitiveReply") : submission.display;
    void this.sendUserTurn(
      client,
      { sessionId: this.sessionId, wizardAnswer: submission.answer },
      displayText,
      true,
    );
  }

  cancelWizardStep(message: CustodianMessage): void {
    const step = message.step;
    const client = this.activeClient;
    if (
      !step ||
      (!this.wizardInputPending && !(this.wizardSettling && step.type === "qr")) ||
      !client ||
      !this.chatAvailable ||
      !this.wizardCancelAvailable ||
      this.sending ||
      this.setupRequired
    ) {
      this.emit();
      return;
    }
    if (step.type === "qr") {
      // Cancellation is the only client mutation for a passive QR. Stop its poll before
      // sending so a timer cannot abort the owner-controlled cancellation request.
      this.qrSession.clearAndScrub(step.id);
    }
    void this.sendUserTurn(
      client,
      { sessionId: this.sessionId, wizardCancel: { stepId: step.id } },
      t("custodian.cancel"),
      true,
    );
  }

  exitSetup(): void {
    // Leaving setup revokes navigation authority from every in-flight reply.
    // The destination surface separately decides whether to retain or rotate context.
    this.revokeNavigationAuthority();
    this.context?.navigate("chat");
  }

  private revokeNavigationAuthority(): void {
    this.qrSession.clearAndScrub();
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.requestEpoch += 1;
    this.sending = false;
    this.questionReplyUncertain = false;
    this.retryParams = null;
    this.error = null;
  }

  openModelSetup(): void {
    this.revokeNavigationAuthority();
    this.context?.navigate("model-setup");
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private startSession(
    client: GatewayBrowserClient,
    variant: CustodianSessionVariant,
    loadTranscript: boolean,
  ): void {
    this.sessionId = createCustodianSessionId();
    this.sessionVariant = variant;
    this.sessionClient = client;
    this.sessionOwnershipKey = resolveCustodianSessionOwnershipKey(this.context) ?? null;
    this.sessionStarted = true;
    void this.initializeSession(
      client,
      { sessionId: this.sessionId, ...custodianChatParams(variant) },
      loadTranscript,
    );
  }

  private abandonPendingUserTurn(pendingParams: SystemAgentChatParams | null): void {
    if (!pendingParams || !hasCustodianUserInput(pendingParams)) {
      return;
    }
    this.retryParams = null;
    // The gateway may already have acted, so keep the warning without retaining replayable text.
    this.abandonedTurnOutcomeUnknown = true;
  }

  private rotateVolatileSession(
    client: GatewayBrowserClient,
    variant: CustodianSessionVariant,
  ): void {
    this.answeredQuestions = retireCustodianQuestions(this.messages, this.answeredQuestions);
    this.retryParams = null;
    this.input = "";
    resetCustodianWizardState(this);
    this.error = null;
    this.setupIssue = null;
    this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
    this.startSession(client, variant, false);
  }

  private synchronizeClient(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const snapshot = context.gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const chatAccess = resolveCustodianChatAccess(snapshot);
    const configuredInferenceState = resolveCustodianConfiguredInferenceState(this.context);
    const inferenceStateChanged = configuredInferenceState !== this.configuredInferenceState;
    this.configuredInferenceState = configuredInferenceState;
    const variantChanged = this.sessionStarted && this.sessionVariant !== this.variant;
    const ownershipKey = resolveCustodianSessionOwnershipKey(this.context);
    const clientReplaced =
      this.sessionStarted &&
      client !== null &&
      this.sessionClient !== null &&
      client !== this.sessionClient;
    const ownershipChanged =
      this.sessionStarted &&
      ownershipKey !== undefined &&
      (ownershipKey !== this.sessionOwnershipKey || (clientReplaced && ownershipKey === null));
    const pendingQrStepId = this.qrSession.pendingStepId(
      this.wizardInputPending || this.wizardSettling,
    );
    if (
      client === this.activeClient &&
      !variantChanged &&
      !clientReplaced &&
      !ownershipChanged &&
      this.chatAvailable === (chatAccess.supported && configuredInferenceState !== "unresolved") &&
      !inferenceStateChanged
    ) {
      return;
    }
    this.qrSession.clearAndScrub();
    const pendingParams = this.sending && this.retryParams ? this.retryParams : null;
    [this.activeClient, this.sending, this.chatAvailable] = [client, false, false];
    this.requestEpoch += 1;
    if (clientReplaced && !chatAccess.supported) {
      this.sessionStarted = false;
      this.abandonPendingUserTurn(pendingParams);
      this.error = chatAccess.unsupported ? t("custodian.unsupportedGateway") : null;
      return;
    }
    if (client && ownershipKey === undefined) {
      this.abandonPendingUserTurn(pendingParams);
      return;
    }
    if (variantChanged || ownershipChanged) {
      [this.eventNudge, this.eventNudgePending] = [null, null];
      this.eventNudgeClosed = false;
      this.abandonedTurnOutcomeUnknown = false;
      this.sessionStarted = false;
      this.clearConversation();
    } else if (client && clientReplaced) {
      this.chatAvailable = true;
      this.abandonPendingUserTurn(pendingParams);
      if (pendingQrStepId) {
        this.retryParams = null;
        this.error = null;
        this.sessionClient = client;
        this.qrSession.schedulePoll(client, pendingQrStepId);
        return;
      }
      this.rotateVolatileSession(client, this.variant);
      return;
    } else if (pendingParams) {
      if (pendingParams?.message === undefined) {
        this.error = t("custodian.connectionChanged");
      }
      this.abandonPendingUserTurn(pendingParams);
    }
    if (!client) {
      return;
    }
    if (!chatAccess.supported) {
      this.error = chatAccess.unsupported ? t("custodian.unsupportedGateway") : null;
      return;
    }
    if (configuredInferenceState === "unresolved") {
      return;
    }
    this.chatAvailable = true;
    if (configuredInferenceState === "required") {
      this.sessionStarted = false;
      this.clearConversation();
      this.setupIssue = "missing";
      return;
    }
    if (inferenceStateChanged) {
      this.setupIssue = null;
    }
    if (this.sessionStarted) {
      if (!this.retryParams) {
        this.error = pendingParams ? this.error : null;
      }
      const pendingStep =
        this.wizardInputPending || this.wizardSettling
          ? this.messages.findLast((message) => message.step !== null)?.step
          : null;
      if (pendingStep?.type === "qr") {
        // A reconnect invalidates the old timer, but the Gateway still owns the QR session.
        this.qrSession.schedulePoll(client, pendingStep.id);
      }
      return;
    }
    this.clearConversation();
    this.startSession(client, this.variant, true);
  }

  private async initializeSession(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    loadTranscript = true,
  ): Promise<void> {
    const epoch = ++this.requestEpoch;
    this.sending = true;
    this.error = null;
    this.retryParams = params;
    this.emit();
    if (loadTranscript) {
      const transcript = await loadCustodianTranscriptProjection({
        client,
        context: this.context,
        firstMessageId: this.nextMessageId,
        isCurrent: () => epoch === this.requestEpoch && client === this.activeClient,
      });
      if (transcript) {
        this.messages = transcript.messages;
        this.nextMessageId = transcript.nextMessageId;
        this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
        this.emit();
      }
    }
    if (epoch !== this.requestEpoch || client !== this.activeClient) {
      return;
    }
    await this.requestReply(client, params);
  }

  private clearConversation(): void {
    this.qrSession.clear();
    this.messages = [];
    this.dismissedQuestions = new Set();
    this.answeredQuestions = new Set();
    this.retryParams = null;
    this.error = null;
    this.setupIssue = null;
    this.input = "";
    resetCustodianWizardState(this);
    this.earlierBoundaryAfterId = null;
  }

  private async requestReply(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    options?: {
      pollStepId?: string;
      qrPresentationGeneration?: number;
    },
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    const context = this.context;
    if (!context) {
      return "rejected";
    }
    const snapshot = context.gateway.snapshot;
    if (
      snapshot.client !== client ||
      !canCallGatewayMethod(snapshot, "openclaw.chat", "operator.admin")
    ) {
      return "rejected";
    }
    this.requestAbort?.abort();
    const requestAbort = new AbortController();
    this.requestAbort = requestAbort;
    const pollStepId = options?.pollStepId;
    const epoch = ++this.requestEpoch;
    let delivery: eventNudgeState.CustodianSendDelivery = "unsent";
    if (!pollStepId) {
      this.sending = true;
      this.error = null;
      if (hasCustodianUserInput(params)) {
        this.setupIssue = null;
      }
      this.retryParams = params;
      this.emit();
    }
    try {
      const result = await client.request<SystemAgentChatResult>("openclaw.chat", params, {
        timeoutMs: SYSTEM_AGENT_CHAT_TIMEOUT_MS,
        onSent: () => (delivery = "sent"),
        signal: requestAbort.signal,
      });
      delivery = "received";
      if (epoch !== this.requestEpoch || client !== this.activeClient) {
        return "sent";
      }
      this.sessionId = result.sessionId;
      if (
        pollStepId &&
        this.qrSession.projectPoll({
          client,
          result,
          stepId: pollStepId,
          presentationGeneration: options.qrPresentationGeneration,
        })
      ) {
        return "sent";
      }
      if (pollStepId) {
        this.qrSession.settlePoll(pollStepId);
      } else {
        this.qrSession.clear();
      }
      const projection = projectCustodianChatResult(
        result,
        this.nextMessageId,
        SILENT_REPLY_PATTERN.test(result.reply),
      );
      this.sensitive = projection.sensitive;
      this.wizardInputPending = projection.wizardInputPending;
      this.wizardSettling = projection.wizardSettling;
      [this.retryParams, this.setupIssue] = [null, null];
      const step = result.step ?? null;
      this.wizardValue = projection.wizardValue;
      this.wizardSecretVisible = false;
      if (projection.message) {
        this.messages = [...this.messages, projection.message];
        this.nextMessageId += 1;
      }
      if (step?.type === "qr") {
        this.qrSession.scheduleStep(client, result);
      }
      if (result.action === "open-agent") {
        let sessionKey = context.gateway.snapshot.sessionKey?.trim();
        if (result.agentId) {
          const roster = await context.agents.refreshList();
          if (epoch !== this.requestEpoch || client !== this.activeClient) {
            return "sent";
          }
          sessionKey = buildAgentMainSessionKey({
            agentId: result.agentId,
            mainKey: roster?.mainKey,
          });
          selectApplicationSession({
            selection: context.agentSelection,
            gateway: context.gateway,
            sessionKey,
            agentId: result.agentId,
          });
        }
        if (result.agentDraft === "hatch" && sessionKey) {
          context.navigate("chat", {
            pathname: pathForCustodianAgentHandoff(context, sessionKey),
            search: `?draft=${encodeURIComponent(t("custodian.hatchDraft"))}`,
          });
        } else {
          this.exitSetup();
        }
      } else if (result.action === "exit") {
        this.exitSetup();
      }
      return "sent";
    } catch (error) {
      if (pollStepId) {
        if (epoch === this.requestEpoch && client === this.activeClient) {
          return this.qrSession.handlePollError({ client, stepId: pollStepId, error, delivery });
        }
        return eventNudgeState.classifyCustodianSendFailure(error, delivery);
      }
      if (epoch === this.requestEpoch && client === this.activeClient) {
        this.error = custodianErrorMessage(error);
        this.setupIssue = resolveCustodianSetupIssue(error, this.configuredInferenceState);
        if (hasCustodianUserInput(params) && isCustodianSessionInvalidatedError(error)) {
          // Retained transcript rows are display context only; the next turn needs a fresh id.
          this.rotateVolatileSession(client, this.variant);
          this.error = t("custodian.sessionRestarted", { error: custodianErrorMessage(error) });
        }
      }
      if (hasCustodianUserInput(params) && this.retryParams === params) {
        // User turns have no idempotency key and are never replayed after an ambiguous failure.
        this.retryParams = null;
      }
      return eventNudgeState.classifyCustodianSendFailure(error, delivery);
    } finally {
      if (this.requestAbort === requestAbort) {
        this.requestAbort = null;
      }
      if (!pollStepId && epoch === this.requestEpoch) {
        this.sending = false;
      }
      this.emit();
    }
  }
}

export const custodianSessionStore = new CustodianSessionStore();
