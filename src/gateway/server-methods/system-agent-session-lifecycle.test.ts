import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  assertSystemAgentSessionStoreActive,
  disposeSystemAgentSessionsForOwner,
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
    const release = createDeferred<void>();
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
});
