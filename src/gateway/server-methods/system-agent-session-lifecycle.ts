import {
  createAdmittedWizardSession,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import type { GatewayRequestContext } from "./types.js";

type SystemAgentSessions = GatewayRequestContext["systemAgentSessions"];
type WizardSessions = GatewayRequestContext["wizardSessions"];
type GatewayWizardSession = WizardSessions extends Map<string, infer Session> ? Session : never;
type ApprovalManager = NonNullable<GatewayRequestContext["systemAgentApprovalManager"]>;

const retiredStores = new WeakSet<SystemAgentSessions>();
const pendingDisposals = new WeakMap<SystemAgentSessions, Set<Promise<void>>>();
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
  retiredWizardStores.add(params.wizardSessions);
  const disposals: Promise<unknown>[] = [
    ...(pendingDisposals.get(params.sessions) ?? []),
    ...(pendingWizardAdmissions.get(params.wizardSessions) ?? []),
  ];
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
