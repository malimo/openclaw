import {
  createAdmittedWizardSession,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import type { GatewayRequestContext } from "./types.js";

type SystemAgentSessions = GatewayRequestContext["systemAgentSessions"];
type SystemAgentSession = SystemAgentSessions extends Map<string, infer Session> ? Session : never;
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

function settleCleanupTasks(
  tasks: Iterable<PromiseLike<unknown>>,
  describeFailure: (errorCount: number) => string,
): Promise<void> {
  return Promise.allSettled(tasks).then((results) => {
    const errors = results.flatMap((result) => {
      if (result.status !== "rejected") {
        return [];
      }
      return result.reason instanceof AggregateError ? result.reason.errors : [result.reason];
    });
    if (errors.length > 0) {
      throw new AggregateError(errors, describeFailure(errors.length));
    }
  });
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

export function disposeSystemAgentSession(params: {
  sessions: SystemAgentSessions;
  sessionId: string;
  session: SystemAgentSession;
  approvalManager?: ApprovalManager;
  reason: string;
}): Promise<void> {
  const ownsEntry = params.sessions.get(params.sessionId) === params.session;
  if (ownsEntry) {
    params.sessions.delete(params.sessionId);
  }
  // Register disposal in the same turn as removal so shutdown sees either the
  // live map entry or its cleanup, including when approval expiry throws.
  const disposal = trackDisposal(params.sessions, params.session.engine.dispose());
  if (!ownsEntry || !params.session.pendingApproval || !params.approvalManager) {
    return disposal;
  }
  let approvalExpiration = Promise.resolve();
  try {
    params.approvalManager.expire(params.session.pendingApproval.id, params.reason);
  } catch (error) {
    // Durable-store faults stay asynchronous so one approval cannot skip sibling cleanup.
    approvalExpiration = Promise.reject(error);
  }
  const cleanup = settleCleanupTasks(
    [disposal, approvalExpiration],
    (errorCount) => `Failed to clean up ${errorCount} OpenClaw session resource(s)`,
  );
  return trackDisposal(params.sessions, cleanup);
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
    disposals.push(
      disposeSystemAgentSession({
        sessions: params.sessions,
        sessionId,
        session,
        approvalManager: params.approvalManager,
        reason: "session-owner-disconnected",
      }),
    );
  }
  const disposal = settleCleanupTasks(
    disposals,
    (errorCount) => `Failed to dispose ${errorCount} OpenClaw session(s)`,
  );
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
    disposals.push(
      disposeSystemAgentSession({
        sessions: params.sessions,
        sessionId,
        session,
        approvalManager: params.approvalManager,
        reason: "gateway-shutdown",
      }),
    );
  }
  for (const [sessionId, session] of params.wizardSessions) {
    params.wizardSessions.delete(sessionId);
    session.cancel();
    disposals.push(whenAdmittedWizardSessionSettled(session));
  }
  const disposal = settleCleanupTasks(
    disposals,
    (errorCount) => `Failed to settle ${errorCount} Gateway setup owner(s)`,
  );
  return trackDisposal(params.sessions, disposal);
}
