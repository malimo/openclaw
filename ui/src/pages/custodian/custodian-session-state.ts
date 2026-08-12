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

/**
 * Resolve the Gateway-authoritative reconnect owner. `undefined` means the
 * browser is still deriving a legacy scope; `null` means no durable owner exists.
 */
export function resolveCustodianSessionOwnershipKey(
  context: ApplicationContext | null,
): string | null | undefined {
  if (!context || context.gateway.snapshot.phase !== "connected") {
    return undefined;
  }
  const snapshot = context.gateway.snapshot;
  const serverScope = snapshot.hello?.auth.recoveryScope?.trim();
  const client = snapshot.client;
  if (!serverScope && !client?.recoveryScopeReady) {
    return undefined;
  }
  const recoveryScope = serverScope || client?.recoveryScope.trim();
  const { gatewayUrl, token, password, bootstrapToken } = context.gateway.connection;
  return recoveryScope
    ? JSON.stringify([gatewayUrl, token, password, bootstrapToken, recoveryScope])
    : null;
}

export function resetCustodianWizardState(state: CustodianWizardState): void {
  state.wizardValue = undefined;
  state.wizardSecretVisible = false;
  state.sensitive = false;
  state.wizardInputPending = false;
  state.wizardSettling = false;
  state.questionReplyUncertain = false;
}
