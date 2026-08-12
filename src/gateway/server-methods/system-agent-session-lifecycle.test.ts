import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WizardSession } from "../../wizard/session.js";
import {
  assertSystemAgentSessionStoreActive,
  admitWizard,
  disposeSystemAgentSessionsForOwner,
  initializeSystemAgentSession,
  retireAndDisposeSystemAgentSessions,
} from "./system-agent-session-lifecycle.js";
import type { GatewayRequestContext } from "./types.js";

type Sessions = GatewayRequestContext["systemAgentSessions"];
type Session = Sessions extends Map<string, infer Value> ? Value : never;

function session(ownerKey: string, dispose: () => Promise<void>): Session {
  return {
    ownerKey,
    engine: { dispose },
  } as unknown as Session;
}

describe("system-agent session lifecycle", () => {
  it("removes one connection owner synchronously and joins its disposal", async () => {
    const release = createDeferred();
    const sessions = new Map([
      ["connection-session", session("connection:one", async () => await release.promise)],
      ["device-session", session("device:two", async () => undefined)],
    ]) as Sessions;

    const disposal = disposeSystemAgentSessionsForOwner({
      sessions,
      ownerKey: "connection:one",
    });

    expect(sessions.has("connection-session")).toBe(false);
    expect(sessions.has("device-session")).toBe(true);
    release.resolve();
    await expect(disposal).resolves.toBeUndefined();
  });

  it("retires admission before cancelling and joining every setup owner", async () => {
    const dispose = vi.fn(async () => undefined);
    const cancel = vi.fn(() => true);
    const sessions = new Map([["session", session("device:one", dispose)]]) as Sessions;
    const wizardSessions = new Map([
      [
        "wizard",
        {
          cancel,
          whenSettled: async () => undefined,
        },
      ],
    ]) as unknown as GatewayRequestContext["wizardSessions"];

    await retireAndDisposeSystemAgentSessions({ sessions, wizardSessions });

    expect(() => assertSystemAgentSessionStoreActive(sessions)).toThrow("shutting down");
    expect(sessions.size).toBe(0);
    expect(wizardSessions.size).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("continues retirement after approval expiry fails and joins every cleanup", async () => {
    const releaseFirstDisposal = createDeferred();
    const releaseSecondDisposal = createDeferred();
    const wizardSettled = createDeferred();
    const approvalError = new Error("approval store unavailable");
    const disposalError = new Error("second disposal failed");
    const firstDispose = vi.fn(async () => await releaseFirstDisposal.promise);
    const secondDispose = vi.fn(async () => {
      await releaseSecondDisposal.promise;
      throw disposalError;
    });
    const firstSession = session("device:one", firstDispose);
    firstSession.pendingApproval = { id: "approval-one" } as Session["pendingApproval"];
    const secondSession = session("device:two", secondDispose);
    secondSession.pendingApproval = { id: "approval-two" } as Session["pendingApproval"];
    const sessions = new Map([
      ["first", firstSession],
      ["second", secondSession],
    ]) as Sessions;
    const cancel = vi.fn(() => true);
    const wizardSessions = new Map([
      [
        "wizard",
        {
          cancel,
          whenSettled: () => wizardSettled.promise,
        },
      ],
    ]) as unknown as GatewayRequestContext["wizardSessions"];
    const expire = vi.fn((approvalId: string) => {
      if (approvalId === "approval-one") {
        throw approvalError;
      }
      return true;
    });
    let synchronousError: unknown;
    let retirement: Promise<void> | undefined;

    try {
      retirement = retireAndDisposeSystemAgentSessions({
        sessions,
        wizardSessions,
        approvalManager: {
          expire,
        } as unknown as GatewayRequestContext["systemAgentApprovalManager"],
      });
    } catch (error) {
      synchronousError = error;
    }

    expect(synchronousError).toBeUndefined();
    expect(retirement).toBeDefined();
    expect(sessions.size).toBe(0);
    expect(wizardSessions.size).toBe(0);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(expire).toHaveBeenCalledTimes(2);

    let retirementSettled = false;
    void retirement?.then(
      () => {
        retirementSettled = true;
      },
      () => {
        retirementSettled = true;
      },
    );
    releaseFirstDisposal.resolve();
    releaseSecondDisposal.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(retirementSettled).toBe(false);

    wizardSettled.resolve();
    const failure = await retirement?.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([approvalError, disposalError]);
  });

  it("joins an admitted wizard that reaches registration during shutdown", async () => {
    const runnerSettled = createDeferred();
    const cancel = vi.fn(() => true);
    const sessions = new Map() as Sessions;
    const wizardSessions = new Map() as GatewayRequestContext["wizardSessions"];
    const createSession = vi.fn(
      () =>
        ({
          cancel,
          whenSettled: () => runnerSettled.promise,
        }) as unknown as WizardSession,
    );

    const admission = admitWizard(wizardSessions, "late-wizard", createSession, false);
    let retirementResolved = false;
    const retirement = retireAndDisposeSystemAgentSessions({ sessions, wizardSessions }).then(
      () => {
        retirementResolved = true;
      },
    );

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(retirementResolved).toBe(false);
    expect(wizardSessions.size).toBe(0);

    runnerSettled.resolve();
    await expect(admission).resolves.toBeUndefined();
    await retirement;
    expect(retirementResolved).toBe(true);

    const postRetirementFactory = vi.fn<() => WizardSession>(() => {
      throw new Error("retired wizard factory must not run");
    });
    await expect(
      admitWizard(wizardSessions, "after-retirement", postRetirementFactory, false),
    ).resolves.toBeUndefined();
    expect(postRetirementFactory).not.toHaveBeenCalled();
  });

  it("reports initialization cleanup failure to retirement without replacing the request error", async () => {
    const release = createDeferred();
    const requestError = new Error("request failed");
    const cleanupError = new Error("cleanup failed");
    const lateSession = session("device:one", async () => {
      throw cleanupError;
    });
    const sessions = new Map() as Sessions;
    const initialization = initializeSystemAgentSession(
      sessions,
      "late-session",
      async ({ ownEngine }) => {
        ownEngine(lateSession.engine);
        await release.promise;
        throw requestError;
      },
    );

    const retirement = retireAndDisposeSystemAgentSessions({
      sessions,
      wizardSessions: new Map(),
    });
    const retirementSettlement = expect(retirement).rejects.toMatchObject({
      errors: [cleanupError],
    });
    release.resolve();

    await expect(initialization).rejects.toBe(requestError);
    await retirementSettlement;
    expect(sessions.size).toBe(0);
  });

  it("retains a settled initialization cleanup failure until retirement reports it once", async () => {
    const requestError = new Error("request failed before retirement");
    const cleanupError = new Error("cleanup failed before retirement");
    const sessions = new Map() as Sessions;
    const wizardSessions = new Map() as GatewayRequestContext["wizardSessions"];
    const initialization = initializeSystemAgentSession(
      sessions,
      "failed-session",
      async ({ ownEngine }) => {
        ownEngine(
          session("device:one", async () => {
            throw cleanupError;
          }).engine,
        );
        throw requestError;
      },
    );

    await expect(initialization).rejects.toBe(requestError);
    await expect(
      retireAndDisposeSystemAgentSessions({ sessions, wizardSessions }),
    ).rejects.toMatchObject({ errors: [cleanupError] });
    await expect(
      retireAndDisposeSystemAgentSessions({ sessions, wizardSessions }),
    ).resolves.toBeUndefined();
  });
});
