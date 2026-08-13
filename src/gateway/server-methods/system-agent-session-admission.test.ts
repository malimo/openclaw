// OpenClaw Gateway tests cover chat initialization, admission, and replacement.

import "./system-agent.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { defaultRuntime } from "../../runtime.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  disposeSystemAgentSessionsForOwner,
  retireAndDisposeSystemAgentSessions,
} from "./system-agent-session-lifecycle.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import {
  callChat,
  defaultClient,
  inferenceFallbackMocks,
  makeContext,
  makeRespond,
  requireVerifiedInferenceFixture,
  seededSession,
  stubEngineOverview,
  systemAgentHandler,
  waitOneTask,
} from "./system-agent.test-support.js";
import type { GatewayClient } from "./types.js";

describe("openclaw.chat", () => {
  it("refuses to create a session before inference is available", async () => {
    inferenceFallbackMocks.verify.mockResolvedValueOnce({
      ok: false,
      status: "unavailable",
      error: "no configured model",
    });
    const sessions = new Map<string, SystemAgentChatSession>();

    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "OpenClaw requires working inference: no configured model",
        details: {
          code: "system_agent_inference_unavailable",
        },
      },
    });
    expect(sessions.size).toBe(0);
    expect(inferenceFallbackMocks.verify).toHaveBeenCalledWith({
      runtime: defaultRuntime,
    });
  });

  it("coalesces concurrent initialization for the same session", async () => {
    stubEngineOverview();
    const started = createDeferred();
    const release = createDeferred();
    inferenceFallbackMocks.verify.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 10,
        binding: requireVerifiedInferenceFixture(),
      };
    });
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);

    const first = callChat(context, { sessionId: "shared" });
    await started.promise;
    const second = callChat(context, { sessionId: "shared" });
    await waitOneTask();
    release.resolve();
    const [firstCall, secondCall] = await Promise.all([first, second]);

    expect(inferenceFallbackMocks.verify).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(1);
    expect([firstCall.ok, secondCall.ok]).toEqual([true, true]);
  });

  it("joins initialization admitted before retirement and disposes its late engine", async () => {
    stubEngineOverview();
    const verificationStarted = createDeferred();
    const releaseVerification = createDeferred();
    inferenceFallbackMocks.verify.mockImplementationOnce(async () => {
      verificationStarted.resolve();
      await releaseVerification.promise;
      return {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 10,
        binding: requireVerifiedInferenceFixture(),
      };
    });
    const dispose = vi.spyOn(SystemAgentChatEngine.prototype, "dispose");
    const sessions = new Map<string, SystemAgentChatSession>();
    const { respond } = makeRespond();
    const initialization = systemAgentHandler("openclaw.chat")({
      params: { sessionId: "late-initialization" },
      client: defaultClient,
      respond,
      context: makeContext(sessions),
    } as never);
    await verificationStarted.promise;

    let retirementResolved = false;
    const retirement = retireAndDisposeSystemAgentSessions({
      sessions,
      wizardSessions: new Map(),
    }).then(() => {
      retirementResolved = true;
    });
    await waitOneTask();
    expect(retirementResolved).toBe(false);

    const requestSettlement = expect(initialization).rejects.toThrow(
      "OpenClaw session owner is shutting down.",
    );
    releaseVerification.resolve();
    await requestSettlement;
    await retirement;

    expect(retirementResolved).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(0);
  });

  it("does not evict a live session for a disconnected initializer", async () => {
    const verificationStarted = createDeferred();
    const releaseVerification = createDeferred();
    inferenceFallbackMocks.verify.mockImplementationOnce(async () => {
      verificationStarted.resolve();
      await releaseVerification.promise;
      return {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 10,
        binding: requireVerifiedInferenceFixture(),
      };
    });
    stubEngineOverview();
    const oldest = seededSession({ lastUsedAt: 0 });
    const disposeOldest = vi.spyOn(oldest.engine, "dispose");
    const sessions = new Map<string, SystemAgentChatSession>([["oldest", oldest]]);
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`existing-${index}`, seededSession({ lastUsedAt: index }));
    }
    const isConnectionActive = vi.fn(() => true);
    const context = makeContext(sessions);
    context.isConnectionActive = isConnectionActive;
    const client = {
      connId: "conn-initializing",
      connect: { caps: [] },
    } as unknown as GatewayClient;

    const pending = callChat(context, { sessionId: "disconnected" }, client);
    await verificationStarted.promise;
    isConnectionActive.mockReturnValue(false);
    releaseVerification.resolve();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        details: { code: "system_agent_session_invalidated" },
      },
    });
    expect(disposeOldest).not.toHaveBeenCalled();
    expect(sessions.size).toBe(8);
    expect(sessions.has("oldest")).toBe(true);
    expect(sessions.has("disconnected")).toBe(false);
  });

  it("publishes a replacement before awaiting evicted-session cleanup", async () => {
    const evictionStarted = createDeferred();
    const releaseEviction = createDeferred();
    const oldest = seededSession({ lastUsedAt: 0 });
    const disposeOldest = vi.spyOn(oldest.engine, "dispose").mockImplementation(async () => {
      evictionStarted.resolve();
      await releaseEviction.promise;
    });
    const sessions = new Map<string, SystemAgentChatSession>([["oldest", oldest]]);
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`existing-${index}`, seededSession({ lastUsedAt: index }));
    }
    stubEngineOverview();
    const isConnectionActive = vi.fn(() => true);
    const context = makeContext(sessions);
    context.isConnectionActive = isConnectionActive;
    const client = {
      connId: "conn-replacement",
      connect: { caps: [] },
    } as unknown as GatewayClient;
    const { calls, respond } = makeRespond();

    const pending = systemAgentHandler("openclaw.chat")({
      params: { sessionId: "replacement" },
      client,
      context,
      respond,
    } as never);
    await evictionStarted.promise;
    const replacement = sessions.get("replacement");
    expect(sessions.size).toBe(8);
    expect(sessions.has("oldest")).toBe(false);
    const disposeReplacement = replacement ? vi.spyOn(replacement.engine, "dispose") : undefined;
    isConnectionActive.mockReturnValue(false);
    const disconnect = disposeSystemAgentSessionsForOwner({
      sessions,
      ownerKey: "connection:conn-replacement",
    });
    releaseEviction.resolve();
    await Promise.all([pending, disconnect]);

    expect(replacement).toBeDefined();
    expect(disposeOldest).toHaveBeenCalledOnce();
    expect(disposeReplacement).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
    expect(sessions.size).toBe(7);
    expect(sessions.has("oldest")).toBe(false);
    expect(sessions.has("replacement")).toBe(false);
  });

  it("keeps a replacement committed when displaced-session cleanup fails", async () => {
    const cleanupError = new Error("old session cleanup failed");
    const oldest = seededSession({ lastUsedAt: 0 });
    const disposeOldest = vi.spyOn(oldest.engine, "dispose").mockRejectedValueOnce(cleanupError);
    const sessions = new Map<string, SystemAgentChatSession>([["oldest", oldest]]);
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`existing-${index}`, seededSession({ lastUsedAt: index }));
    }
    stubEngineOverview();
    const warn = vi.fn();
    const context = makeContext(sessions);
    context.logGateway = { warn } as unknown as GatewayRequestContext["logGateway"];

    await expect(callChat(context, { sessionId: "replacement" })).resolves.toMatchObject({
      ok: true,
    });
    await waitOneTask();

    expect(disposeOldest).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(8);
    expect(sessions.has("oldest")).toBe(false);
    expect(sessions.has("replacement")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/displaced-session cleanup failed:.*old session cleanup failed/),
    );
  });

  it("keeps the session map bounded during concurrent unique initialization", async () => {
    const evictionStarted = createDeferred();
    const releaseEviction = createDeferred();
    const oldest = seededSession({ lastUsedAt: 0 });
    const disposeOldest = vi.spyOn(oldest.engine, "dispose").mockImplementation(async () => {
      evictionStarted.resolve();
      await releaseEviction.promise;
    });
    const sessions = new Map<string, SystemAgentChatSession>([["oldest", oldest]]);
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`existing-${index}`, seededSession({ lastUsedAt: index }));
    }
    stubEngineOverview();

    const context = makeContext(sessions);
    const first = callChat(context, { sessionId: "new-1" });
    const second = callChat(context, { sessionId: "new-2" });
    await evictionStarted.promise;
    await waitOneTask();
    releaseEviction.resolve();
    await Promise.all([first, second]);

    expect(disposeOldest).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(8);
    expect([sessions.has("new-1"), sessions.has("new-2")]).toEqual([true, true]);
  });
});
