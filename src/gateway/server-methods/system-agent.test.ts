// OpenClaw Gateway tests cover ordinary chat turns, history, approvals, and reset.

import "./system-agent.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { readLastSystemAgentAuditEntry } from "../../system-agent/system-agent.test-helpers.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { handleGatewayRequest } from "../server-methods.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import {
  callChat,
  defaultClient,
  inferenceFallbackMocks,
  makeContext,
  makeRespond,
  makeVerifiedEngine,
  requireVerifiedInferenceDeps,
  requireVerifiedInferenceFixture,
  runSensitiveChannelSetup,
  seededSession,
  stubEngineOverview,
  systemAgentHandler,
  systemAgentLane,
  systemAgentTempDirs,
  transcriptStoreMocks,
  verifiedConfig,
  waitOneTask,
} from "./system-agent.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

describe("openclaw.chat", () => {
  it("rejects invalid params", async () => {
    const call = await callChat(makeContext(new Map()), {});
    expect(call.ok).toBe(false);
  });

  it("trims, canonicalizes, and forwards valid UI context for a user turn", async () => {
    const engine = makeVerifiedEngine();
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "Everything is healthy.", action: "none" });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "What about this page?",
      context: { page: "  /settings/channels  ", source: "client" },
    });

    expect(call.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("What about this page?", {
      uiContext: { page: "/settings/channels" },
    });
  });

  it.each([
    { name: "unsafe characters", page: "channels?tab=all" },
    { name: "an overlong id", page: "a".repeat(65) },
    { name: "a Unicode case-folding character", page: "\u212A" },
  ])("drops UI context with $name without rejecting the turn", async ({ page }) => {
    const engine = makeVerifiedEngine();
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "Everything is healthy.", action: "none" });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "Status please.",
      context: { page },
    });

    expect(call.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("Status please.");
  });

  it("does not pass UI context to welcome-only turns", async () => {
    const engine = makeVerifiedEngine();
    const handle = vi.spyOn(engine, "handle");
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      context: { page: "custodian" },
    });

    expect(call.ok).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });

  it("persists completed turns from the engine's sanitized history", async () => {
    const engine = new SystemAgentChatEngine({
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: requireVerifiedInferenceDeps(),
      runAgentTurn: async () => ({ text: "Everything is healthy." }),
      planWithAssistant: async () => null,
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "How is this machine doing?",
      context: { page: "dashboard" },
    });

    expect(call.payload).toMatchObject({ reply: "Everything is healthy." });
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenCalledTimes(2);
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: "user", text: "How is this machine doing?" }),
    );
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ role: "assistant", text: "Everything is healthy." }),
    );
    expect(JSON.stringify(transcriptStoreMocks.appendTranscriptTurn.mock.calls)).not.toContain(
      "ui-context",
    );
  });

  it("seeds a new engine with the persisted tail before recording its welcome", async () => {
    stubEngineOverview();
    transcriptStoreMocks.readTranscriptTail.mockReturnValue([
      { role: "user", text: "Earlier question", at: 1 },
      { role: "assistant", text: "Earlier answer", at: 2 },
    ]);
    const seedHistory = vi.spyOn(SystemAgentChatEngine.prototype, "seedHistory");

    const call = await callChat(makeContext(new Map()), { sessionId: "fresh" });

    expect(call.ok).toBe(true);
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenCalledWith(30, {
      afterLastReset: true,
    });
    expect(seedHistory).toHaveBeenCalledWith([
      { role: "user", text: "Earlier question" },
      { role: "assistant", text: "Earlier answer" },
    ]);
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", text: expect.any(String) }),
    );
  });

  it("persists only the mask marker for a sensitive hosted-wizard answer", async () => {
    const engine = new SystemAgentChatEngine(
      {
        surface: "gateway",
        verifiedInference: requireVerifiedInferenceFixture(),
        deps: requireVerifiedInferenceDeps(),
        runAgentTurn: async () => null,
        planWithAssistant: async () => null,
      },
      { wizardDependencies: { runChannelSetupWizard: runSensitiveChannelSetup } },
    );
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    const prompt = await callChat(context, { sessionId: "s1", message: "connect telegram" });
    expect(prompt.payload).toMatchObject({ sensitive: true, wizardInputPending: true });
    transcriptStoreMocks.appendTranscriptTurn.mockClear();

    await callChat(context, { sessionId: "s1", message: "raw-secret-value" });

    const persisted = transcriptStoreMocks.appendTranscriptTurn.mock.calls.map(([turn]) => turn);
    expect(persisted).toContainEqual(
      expect.objectContaining({ role: "user", text: "<redacted secret>" }),
    );
    expect(JSON.stringify(persisted)).not.toContain("raw-secret-value");
  });

  it("returns history oldest-first with default and explicit bounded limits", async () => {
    const turns = [
      { role: "user" as const, text: "one", at: 1 },
      { role: "assistant" as const, text: "two", at: 2 },
    ];
    transcriptStoreMocks.readTranscriptTail.mockImplementation((limit: number) =>
      turns.slice(-limit),
    );
    const invoke = async (params: Record<string, unknown>) => {
      const { calls, respond } = makeRespond();
      await systemAgentHandler("openclaw.chat.history")({ params, respond } as never);
      return calls[0];
    };

    expect(await invoke({})).toEqual({ ok: true, payload: { turns }, error: undefined });
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenLastCalledWith(100);
    expect(await invoke({ limit: 1 })).toEqual({
      ok: true,
      payload: { turns: [turns[1]] },
      error: undefined,
    });
    expect((await invoke({ limit: 501 }))?.ok).toBe(false);
  });

  it("tracks approved delegated Gateway restarts until their completion drains", async () => {
    const approvalStarted = createDeferred();
    const releaseApproval = createDeferred();
    const stateDir = systemAgentTempDirs.make("openclaw-approved-gateway-restart-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(verifiedConfig));
    const runGatewayRestart = vi.fn(async () => {
      approvalStarted.resolve();
      await releaseApproval.promise;
      return true;
    });
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      surface: "gateway",
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: { ...requireVerifiedInferenceDeps(), runGatewayRestart },
    });
    engine.propose({ kind: "gateway-restart" });
    const proposalHash = expectDefined(
      engine.getPendingOperatorProposal(),
      "restart proposal",
    ).hash;
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "Approval pending.", action: "none" });
    const resolveOperatorApproval = vi.spyOn(engine, "resolveOperatorApproval");
    const delegatedSession = seededSession({
      engine,
      ownerKey: JSON.stringify(["main", "agent:main:main"]),
    });
    const sessions = new Map<string, SystemAgentChatSession>([["delegate-1", delegatedSession]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
    });
    const broadcast = vi.fn();
    const context = {
      ...makeContext(sessions),
      systemAgentApprovalManager: manager,
      broadcast,
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;

    const requestResponses = makeRespond();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "delegated-gateway-restart",
        method: "openclaw.chat",
        params: {
          sessionId: "delegate-1",
          message: "Restart Gateway.",
          context: { page: "channels" },
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
        },
      },
      respond: requestResponses.respond,
      client: {
        ...defaultClient,
        connect: { ...defaultClient.connect, role: "operator", scopes: ["operator.admin"] },
      } as GatewayClient,
      isWebchatConnect: () => false,
      context,
      extraHandlers: { "openclaw.chat": systemAgentHandlers["openclaw.chat"]! },
    });
    const first = expectDefined(requestResponses.calls[0], "delegated Gateway response invariant");
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    const proposalId = (first.payload as { proposalId?: string }).proposalId;

    expect(first.payload).toMatchObject({
      reply: "Approval pending.",
      needsApproval: true,
      proposalId: expect.stringMatching(/^system-agent:/),
    });
    expect(proposalId).toBeTruthy();
    expect(manager.getSnapshot(proposalId!)).toMatchObject({
      request: { proposalHash, agentId: "main", sessionKey: "agent:main:main" },
    });
    expect(manager.getSnapshot(proposalId!)?.decision).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith(
      "openclaw.approval.requested",
      expect.objectContaining({ id: proposalId }),
      { dropIfSlow: true },
    );
    expect(resolveOperatorApproval).not.toHaveBeenCalled();
    expect(handle).toHaveBeenNthCalledWith(1, "Restart Gateway.");

    await callChat(context, {
      sessionId: "delegate-1",
      message: "yes",
      delegation: { agentId: "main", sessionKey: "agent:main:main" },
    });
    expect(resolveOperatorApproval).not.toHaveBeenCalled();

    manager.resolve(proposalId!, "allow-once", "operator-ui");
    await approvalStarted.promise;
    try {
      expect(systemAgentLane()).toMatchObject({ activeCount: 1, queuedCount: 0 });
    } finally {
      releaseApproval.resolve();
    }
    await vi.waitFor(() => {
      expect(resolveOperatorApproval).toHaveBeenCalledWith("allow-once", proposalHash);
      expect(runGatewayRestart).toHaveBeenCalledOnce();
      expect(systemAgentLane().activeCount).toBe(0);
    });
    await expect(resolveOperatorApproval.mock.results[0]?.value).resolves.toMatchObject({
      text: expect.stringContaining("[openclaw] done: gateway.restart"),
    });
    expect(readLastSystemAgentAuditEntry()).toMatchObject({
      operation: "gateway.restart",
      summary: "Scheduled Gateway restart",
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("reuses a live session, then requires fresh fallback verification after failure", async () => {
    stubEngineOverview();
    const engine = new SystemAgentChatEngine({
      verifiedInference: requireVerifiedInferenceFixture(),
      runAgentTurn: async () => {
        throw new Error("workspace owner openclaw is missing from the roster");
      },
      planWithAssistant: async () => null,
      deps: requireVerifiedInferenceDeps(),
    });
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    const failed = await callChat(context, { sessionId: "s1", message: "status please" });

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("workspace owner openclaw is missing from the roster"),
        details: { code: "system_agent_session_invalidated" },
      },
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(false);
    expect(inferenceFallbackMocks.verify).not.toHaveBeenCalled();

    const retried = await callChat(context, { sessionId: "s1" });

    expect(retried.ok).toBe(true);
    expect(inferenceFallbackMocks.verify).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(true);
  });

  it("does not relabel unrelated session failures as inference errors", async () => {
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockRejectedValue(new Error("wizard bug"));
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    await expect(
      callChat(makeContext(sessions), { sessionId: "s1", message: "status please" }),
    ).rejects.toThrow("wizard bug");
    expect(sessions.has("s1")).toBe(true);
  });

  it("tracks every accepted request as active while serializing expensive execution", async () => {
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const firstEngine = makeVerifiedEngine();
    vi.spyOn(firstEngine, "handle").mockImplementation(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { text: "first setup complete", action: "none" };
    });
    const secondEngine = makeVerifiedEngine();
    const secondHandle = vi.spyOn(secondEngine, "handle").mockImplementation(async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
      return { text: "second setup complete", action: "none" };
    });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["s1", seededSession({ engine: firstEngine })],
      ["s2", seededSession({ engine: secondEngine })],
    ]);
    const activeAtResponse: number[] = [];

    const trackChat = (sessionId: string) =>
      systemAgentHandler("openclaw.chat")({
        params: { sessionId, message: "yes" },
        client: defaultClient,
        context: makeContext(sessions),
        respond: () => activeAtResponse.push(systemAgentLane().activeCount),
      } as never);
    const first = trackChat("s1");
    const second = trackChat("s2");

    await firstStarted.promise;
    await waitOneTask();
    expect(systemAgentLane()).toMatchObject({ activeCount: 2, queuedCount: 0 });
    expect(secondHandle).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    await secondStarted.promise;
    expect(systemAgentLane().activeCount).toBe(1);
    releaseSecond.resolve();
    await second;

    expect(activeAtResponse).toEqual([2, 1]);
    expect(systemAgentLane().activeCount).toBe(0);
  });

  it("resets a session on request", async () => {
    stubEngineOverview();
    transcriptStoreMocks.readTranscriptTail.mockReturnValue([]);
    const engine = makeVerifiedEngine();
    const handle = vi.spyOn(engine, "handle");
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const seedHistory = vi.spyOn(SystemAgentChatEngine.prototype, "seedHistory");
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    // Reset drops the stored session; loading a fresh welcome would hit real
    // discovery, so stub the overview loader on the replacement engine path by
    // asserting the old engine is gone instead.
    const { calls, respond } = makeRespond();
    const context = makeContext(sessions);
    const pending = systemAgentHandler("openclaw.chat")({
      params: { sessionId: "s1", reset: true },
      client: defaultClient,
      respond,
      context,
    } as never);
    await pending;
    expect(handle).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.get("s1")?.engine).not.toBe(engine);
    expect(calls[0]?.ok).toBe(true);
    expect(seedHistory).not.toHaveBeenCalled();
    expect(transcriptStoreMocks.appendTranscriptReset).toHaveBeenCalledOnce();

    transcriptStoreMocks.readTranscriptTail.mockReturnValue([
      { role: "user", text: "After reset", at: 3 },
      { role: "assistant", text: "Fresh answer", at: 4 },
    ]);
    const fresh = await callChat(context, { sessionId: "fresh-after-reset" });
    expect(fresh.ok).toBe(true);
    expect(seedHistory).toHaveBeenCalledWith([
      { role: "user", text: "After reset" },
      { role: "assistant", text: "Fresh answer" },
    ]);
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenLastCalledWith(30, {
      afterLastReset: true,
    });
  });
});
