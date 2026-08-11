import type {
  SystemAgentChatParams,
  SystemAgentChatResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";

type SystemAgentChatReply = Awaited<ReturnType<SystemAgentChatEngine["handle"]>>;
type SystemAgentChatEngineInput = Pick<
  SystemAgentChatEngine,
  "answerWizard" | "cancelWizard" | "handle" | "pollStep"
>;

export function getSystemAgentChatInputError(params: SystemAgentChatParams): string | undefined {
  const inputCount = [
    params.message,
    params.wizardAnswer,
    params.wizardCancel,
    params.pollStepId,
  ].filter((value) => value !== undefined).length;
  if (inputCount > 1) {
    return "Send exactly one of message, wizardAnswer, wizardCancel, or pollStepId.";
  }
  if (
    (params.wizardAnswer !== undefined || params.pollStepId !== undefined) &&
    params.delegation !== undefined
  ) {
    return "Delegated OpenClaw sessions cannot answer or poll structured wizard steps.";
  }
  if (
    (params.wizardAnswer !== undefined || params.pollStepId !== undefined) &&
    params.reset === true
  ) {
    return "A wizard answer or poll cannot reset its OpenClaw chat session.";
  }
  if (params.pollStepId !== undefined && (params.welcomeVariant || params.context)) {
    return "A wizard poll cannot include welcome or UI context.";
  }
  if (params.wizardCancel !== undefined && params.delegation !== undefined) {
    return "Delegated OpenClaw sessions cannot cancel hosted wizards.";
  }
  if (params.wizardCancel !== undefined && params.reset === true) {
    return "A wizard cancel cannot reset its OpenClaw chat session.";
  }
  return undefined;
}

export async function runSystemAgentChatInput(params: {
  engine: SystemAgentChatEngineInput;
  input: SystemAgentChatParams;
}): Promise<SystemAgentChatReply | undefined> {
  if (params.input.pollStepId !== undefined) {
    return await params.engine.pollStep(params.input.pollStepId);
  }
  if (params.input.wizardAnswer !== undefined) {
    return await params.engine.answerWizard(params.input.wizardAnswer);
  }
  if (params.input.wizardCancel !== undefined) {
    return await params.engine.cancelWizard(params.input.wizardCancel);
  }
  if (params.input.message === undefined) {
    return undefined;
  }
  return params.input.delegation === undefined && params.input.context
    ? await params.engine.handle(params.input.message, { uiContext: params.input.context })
    : await params.engine.handle(params.input.message);
}

export function buildSystemAgentChatResult(params: {
  sessionId: string;
  reply: SystemAgentChatReply;
  proposalId?: string;
}): SystemAgentChatResult {
  const action =
    params.reply.action === "open-tui"
      ? "open-agent"
      : params.reply.action === "open-setup"
        ? "none"
        : params.reply.action;
  return {
    sessionId: params.sessionId,
    reply:
      params.reply.text ||
      (action === "open-agent"
        ? "Setup here is done — continue with your agent."
        : "Nothing to change."),
    action,
    ...(action === "open-agent" && params.reply.agentDraft
      ? { agentDraft: params.reply.agentDraft }
      : {}),
    ...(action === "open-agent" &&
    params.reply.handoff?.kind === "open-tui" &&
    params.reply.handoff.agentId
      ? { agentId: params.reply.handoff.agentId }
      : {}),
    ...(params.reply.sensitive === true ? { sensitive: true } : {}),
    ...(params.reply.wizardInputPending === true ? { wizardInputPending: true } : {}),
    ...(params.reply.wizardSettling === true ? { wizardSettling: true } : {}),
    ...(params.reply.question ? { question: params.reply.question } : {}),
    ...(params.reply.step ? { step: params.reply.step } : {}),
    ...(params.proposalId ? { needsApproval: true, proposalId: params.proposalId } : {}),
  };
}
