import type { GatewayRequestContext } from "./types.js";

type SystemAgentSessions = GatewayRequestContext["systemAgentSessions"];
type WizardSessions = GatewayRequestContext["wizardSessions"];
type ApprovalManager = NonNullable<GatewayRequestContext["systemAgentApprovalManager"]>;

const retiredStores = new WeakSet<SystemAgentSessions>();
const pendingDisposals = new WeakMap<SystemAgentSessions, Set<Promise<void>>>();

export function assertSystemAgentSessionStoreActive(sessions: SystemAgentSessions): void {
  if (retiredStores.has(sessions)) {
    throw new Error("OpenClaw session owner is shutting down.");
  }
}

function trackDisposal(sessions: SystemAgentSessions, disposal: Promise<void>): Promise<void> {
  let pending = pendingDisposals.get(sessions);
  if (!pending) {
    pending = new Set();
    pendingDisposals.set(sessions, pending);
  }
  pending.add(disposal);
  void disposal.finally(() => pending?.delete(disposal)).catch(() => undefined);
  return disposal;
}

function expireSessionApproval(
  session: SystemAgentSessions extends Map<string, infer Session> ? Session : never,
  approvalManager: ApprovalManager | undefined,
  reason: string,
): void {
  if (session.pendingApproval) {
    approvalManager?.expire(session.pendingApproval.id, reason);
  }
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
    params.sessions.delete(sessionId);
    expireSessionApproval(session, params.approvalManager, "session-owner-disconnected");
    disposals.push(session.engine.dispose());
  }
  const disposal = Promise.allSettled(disposals).then((results) => {
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to dispose ${errors.length} OpenClaw session(s)`);
    }
  });
  return trackDisposal(params.sessions, disposal);
}

export function retireAndDisposeSystemAgentSessions(params: {
  sessions: SystemAgentSessions;
  wizardSessions: WizardSessions;
  approvalManager?: ApprovalManager;
}): Promise<void> {
  retiredStores.add(params.sessions);
  const disposals: Promise<void>[] = [...(pendingDisposals.get(params.sessions) ?? [])];
  for (const [sessionId, session] of params.sessions) {
    params.sessions.delete(sessionId);
    expireSessionApproval(session, params.approvalManager, "gateway-shutdown");
    disposals.push(session.engine.dispose());
  }
  for (const [sessionId, session] of params.wizardSessions) {
    params.wizardSessions.delete(sessionId);
    session.cancel();
    disposals.push(session.whenSettled());
  }
  const disposal = Promise.allSettled(disposals).then((results) => {
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to settle ${errors.length} Gateway setup owner(s)`);
    }
  });
  return trackDisposal(params.sessions, disposal);
}
