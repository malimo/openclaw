import {
  readSystemAgentInferenceUnavailableErrorDetails,
  type SystemAgentChatResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { CustodianConfiguredInferenceState } from "./custodian-session-state.ts";
import { initialCustodianWizardValue } from "./custodian-wizard-step.ts";
import { parseCustodianQuestion } from "./structured-question.ts";
import {
  createCustodianAssistantMessage,
  createCustodianTranscriptMessages,
  readCustodianTranscript,
  type CustodianMessage,
} from "./transcript.ts";

export async function loadCustodianTranscriptProjection(params: {
  client: GatewayBrowserClient;
  context: ApplicationContext | null;
  isCurrent: () => boolean;
  firstMessageId: number;
}): Promise<{ messages: CustodianMessage[]; nextMessageId: number } | null> {
  if (
    !params.context ||
    isGatewayMethodAdvertised(params.context.gateway.snapshot, "openclaw.chat.history") !== true
  ) {
    return null;
  }
  const turns = await readCustodianTranscript(params.client);
  return turns === null || !params.isCurrent()
    ? null
    : createCustodianTranscriptMessages(turns, params.firstMessageId);
}

export function projectCustodianChatResult(
  result: SystemAgentChatResult,
  nextMessageId: number,
  silentReply: boolean,
): {
  sensitive: boolean;
  wizardInputPending: boolean;
  wizardSettling: boolean;
  wizardValue: unknown;
  message: CustodianMessage | null;
} {
  const step = result.step ?? null;
  const question = step ? null : parseCustodianQuestion(result.question);
  return {
    sensitive: result.sensitive === true,
    wizardInputPending: result.wizardInputPending === true,
    wizardSettling: result.wizardSettling === true,
    wizardValue: step ? initialCustodianWizardValue(step) : undefined,
    message:
      !silentReply || question || step
        ? createCustodianAssistantMessage({
            id: nextMessageId,
            text: silentReply ? "" : result.reply,
            question,
            step,
          })
        : null,
  };
}

export function resolveCustodianSetupIssue(
  error: unknown,
  configuredInferenceState: CustodianConfiguredInferenceState,
): "missing" | "unavailable" | null {
  const details =
    error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
  return readSystemAgentInferenceUnavailableErrorDetails(details) === undefined
    ? null
    : configuredInferenceState === "required"
      ? "missing"
      : "unavailable";
}
