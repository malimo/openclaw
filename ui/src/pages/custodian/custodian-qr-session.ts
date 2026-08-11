import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  CustodianQrScheduler,
  findCustodianQrStep,
  replaceCustodianQrStep,
  scrubCustodianQrSteps,
} from "./custodian-wizard-step.ts";
import * as eventNudgeState from "./event-nudge.ts";
import { isCustodianSessionInvalidatedError } from "./session-lifecycle.ts";
import type { CustodianMessage } from "./transcript.ts";

type CustodianQrState = {
  messages: CustodianMessage[];
  wizardInputPending: boolean;
  wizardSettling: boolean;
  questionReplyUncertain: boolean;
  abandonedTurnOutcomeUnknown: boolean;
  error: string | null;
};

export class CustodianQrSession {
  private readonly scheduler: CustodianQrScheduler;

  constructor(
    private readonly state: CustodianQrState,
    callbacks: {
      emit: () => void;
      poll: (client: GatewayBrowserClient, stepId: string, generation: number) => void;
      invalidate: (client: GatewayBrowserClient) => void;
    },
  ) {
    this.scheduler = new CustodianQrScheduler({
      onExpire: (stepId, notify) => {
        this.scrub(stepId);
        if (notify) {
          callbacks.emit();
        }
      },
      onPoll: callbacks.poll,
    });
    this.invalidate = callbacks.invalidate;
  }

  private readonly invalidate: (client: GatewayBrowserClient) => void;

  clear(): void {
    this.scheduler.clear();
  }

  clearAndScrub(stepId?: string): void {
    this.clear();
    this.scrub(stepId);
  }

  scrub(stepId?: string): void {
    this.state.messages = scrubCustodianQrSteps(this.state.messages, stepId);
  }

  scheduleStep(client: GatewayBrowserClient, result: SystemAgentChatResult): void {
    if (result.step) {
      this.scheduler.scheduleStep(client, result.step);
    }
  }

  schedulePoll(client: GatewayBrowserClient, stepId: string): void {
    this.scheduler.schedulePoll(client, stepId);
  }

  pendingStepId(active: boolean): string | undefined {
    return active
      ? this.state.messages.findLast((message) => message.step?.type === "qr")?.step?.id
      : undefined;
  }

  projectPoll(params: {
    client: GatewayBrowserClient;
    result: SystemAgentChatResult;
    stepId: string;
    presentationGeneration?: number;
  }): boolean {
    const { client, result, stepId } = params;
    this.state.error = null;
    if (result.step?.type === "qr" && result.step.id === stepId) {
      if (
        params.presentationGeneration !== undefined &&
        !this.scheduler.isPollPresentationCurrent(stepId, params.presentationGeneration)
      ) {
        // Expiry retired the credential while this request was in flight. Keep observing,
        // but never let that stale response restore the scrubbed QR bytes.
        this.scrub(stepId);
        this.schedulePoll(client, stepId);
        return true;
      }
      this.state.messages = replaceCustodianQrStep(this.state.messages, result.step);
      this.state.wizardInputPending = result.wizardInputPending === true;
      this.state.wizardSettling = result.wizardSettling === true;
      this.scheduler.scheduleStep(client, result.step);
      return true;
    }
    if (result.wizardSettling === true && result.step === undefined) {
      // The external owner can outlive its presentation. Keep polling so typed Cancel
      // remains available until the owner reports success, failure, or cancellation.
      this.scrub(stepId);
      this.state.questionReplyUncertain = false;
      this.state.wizardInputPending = false;
      this.state.wizardSettling = true;
      this.schedulePoll(client, stepId);
      return true;
    }
    return false;
  }

  settlePoll(stepId: string): void {
    this.clearAndScrub(stepId);
    this.state.questionReplyUncertain = false;
    this.state.abandonedTurnOutcomeUnknown = false;
  }

  handlePollError(params: {
    client: GatewayBrowserClient;
    stepId: string;
    error: unknown;
    delivery: eventNudgeState.CustodianSendDelivery;
  }): eventNudgeState.CustodianSendOutcome {
    if (isCustodianSessionInvalidatedError(params.error)) {
      this.clearAndScrub(params.stepId);
      this.invalidate(params.client);
      return "sent";
    }
    const step = findCustodianQrStep(this.state.messages, params.stepId);
    if (step) {
      this.schedulePoll(params.client, step.id);
    }
    return eventNudgeState.classifyCustodianSendFailure(params.error, params.delivery);
  }
}
