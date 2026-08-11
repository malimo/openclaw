import type { SystemAgentChatParams } from "@openclaw/gateway-protocol";
import type { ApplicationContext } from "../../app/context.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

export type CustodianConfiguredInferenceState = "unresolved" | "required" | "ready";

type CustodianWizardState = {
  wizardValue: unknown;
  wizardSecretVisible: boolean;
  sensitive: boolean;
  wizardInputPending: boolean;
  wizardSettling: boolean;
  questionReplyUncertain: boolean;
};

export function hasCustodianUserInput(params: SystemAgentChatParams): boolean {
  return (
    params.message !== undefined ||
    params.wizardAnswer !== undefined ||
    params.wizardCancel !== undefined
  );
}

export function resolveCustodianConfiguredInferenceState(
  context: ApplicationContext | null,
): CustodianConfiguredInferenceState {
  if (!context || context.gateway.snapshot.phase !== "connected") {
    return "unresolved";
  }
  const agentsList = context.agents.state.agentsList;
  if (!agentsList) {
    return "unresolved";
  }
  const selectedId = normalizeAgentId(
    context.gateway.snapshot.assistantAgentId ?? agentsList.defaultId ?? "",
  );
  const selectedAgent = agentsList.agents.find(
    (agent) => normalizeAgentId(agent.id) === selectedId,
  );
  if (!selectedAgent) {
    return "unresolved";
  }
  return selectedAgent.model?.primary?.trim() ? "ready" : "required";
}

function resolveCustodianSessionOwnership(params: {
  context: ApplicationContext | null;
  lastHelloDeviceToken: string;
}): { key: string; lastHelloDeviceToken: string } {
  const context = params.context;
  if (!context) {
    return { key: "", lastHelloDeviceToken: params.lastHelloDeviceToken };
  }
  const { gatewayUrl, token, password, bootstrapToken } = context.gateway.connection;
  const auth = context.gateway.snapshot.hello?.auth;
  const lastHelloDeviceToken = auth ? (auth.deviceToken ?? "") : params.lastHelloDeviceToken;
  return {
    key: JSON.stringify([gatewayUrl, token, password, bootstrapToken, lastHelloDeviceToken]),
    lastHelloDeviceToken,
  };
}

export class CustodianSessionState {
  private lastHelloDeviceToken = "";

  ownershipKey(context: ApplicationContext | null): string {
    const ownership = resolveCustodianSessionOwnership({
      context,
      lastHelloDeviceToken: this.lastHelloDeviceToken,
    });
    this.lastHelloDeviceToken = ownership.lastHelloDeviceToken;
    return ownership.key;
  }
}

export function resetCustodianWizardState(state: CustodianWizardState): void {
  state.wizardValue = undefined;
  state.wizardSecretVisible = false;
  state.sensitive = false;
  state.wizardInputPending = false;
  state.wizardSettling = false;
  state.questionReplyUncertain = false;
}
