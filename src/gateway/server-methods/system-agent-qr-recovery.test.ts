// OpenClaw Gateway tests cover QR reply recovery and capacity leases.

import "./system-agent.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  SystemAgentChatEngine,
  SystemAgentWizardAnswerError,
} from "../../system-agent/chat-engine.js";
import { SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS } from "../../system-agent/chat-wizard-host.js";
import { makeDelayedTerminalQrEngine } from "./system-agent-qr.test-support.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import {
  callChat,
  defaultClient,
  makeContext,
  makeDeliveredQrEngine,
  requireVerifiedInferenceDeps,
  requireVerifiedInferenceFixture,
  seededSession,
  stubEngineOverview,
  systemAgentHandler,
  transcriptStoreMocks,
  waitOneTask,
} from "./system-agent.test-support.js";

describe("openclaw.chat", () => {
  it("persists a delayed terminal QR reply once and replays it after dropped delivery", async () => {
    const delayed = await makeDelayedTerminalQrEngine({
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: requireVerifiedInferenceDeps(),
    });
    const { engine, stepId } = delayed;
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    await delayed.settleOwner();
    const settling = await callChat(context, { sessionId: "s1", pollStepId: stepId });
    expect(settling.payload).toMatchObject({ wizardSettling: true });
    await delayed.auditStarted;
    expect(transcriptStoreMocks.appendTranscriptTurn).not.toHaveBeenCalled();

    await delayed.releaseTerminal();
    await systemAgentHandler("openclaw.chat")({
      params: { sessionId: "s1", pollStepId: stepId },
      respond: () => undefined,
      context,
      client: defaultClient,
    } as never);

    const lostDeliverySession = expectDefined(sessions.get("s1"), "lost delivery session");
    lostDeliverySession.lastUsedAt = 0;
    const otherRetainedEngines = await Promise.all(
      Array.from({ length: 7 }, async () => await makeDeliveredQrEngine()),
    );
    for (const [index, retainedEngine] of otherRetainedEngines.entries()) {
      sessions.set(
        `delivered-${index}`,
        seededSession({
          engine: retainedEngine,
          lastUsedAt: index + 1,
          ownerKey: `device:owner-${index}`,
        }),
      );
    }
    stubEngineOverview();

    const admission = await callChat(context, { sessionId: "new-session" });
    expect(admission).toMatchObject({ ok: true });
    expect(sessions.has("s1")).toBe(true);
    expect(sessions.has("new-session")).toBe(true);
    expect(sessions.size).toBe(9);

    const persistedTerminal = transcriptStoreMocks.appendTranscriptTurn.mock.calls.filter(
      ([turn]) => turn.role === "assistant" && turn.text.includes("is configured"),
    );
    expect(persistedTerminal).toHaveLength(1);
    const terminalText = expectDefined(persistedTerminal[0]?.[0].text, "terminal transcript text");

    const retry = await callChat(context, { sessionId: "s1", pollStepId: stepId });
    expect(retry.payload).toMatchObject({ reply: terminalText });
    expect(
      transcriptStoreMocks.appendTranscriptTurn.mock.calls.filter(
        ([turn]) => turn.role === "assistant" && turn.text === terminalText,
      ),
    ).toHaveLength(1);
  });

  it("invalidates a delayed terminal QR reply after a later ordinary turn", async () => {
    const delayed = await makeDelayedTerminalQrEngine({
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: requireVerifiedInferenceDeps(),
    });
    const { engine, stepId } = delayed;
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    await delayed.settleOwner();
    const settling = await callChat(context, { sessionId: "s1", pollStepId: stepId });
    expect(settling.payload).toMatchObject({ wizardSettling: true });
    await delayed.auditStarted;

    await delayed.releaseTerminal();
    const ordinary = await callChat(context, {
      sessionId: "s1",
      message: "How is this machine doing?",
    });
    expect(ordinary.payload).toMatchObject({ reply: "Everything is healthy." });

    await expect(callChat(context, { sessionId: "s1", pollStepId: stepId })).resolves.toMatchObject(
      {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          details: { code: "system_agent_session_invalidated" },
        },
      },
    );
    expect(transcriptStoreMocks.appendTranscriptTurn.mock.calls.map(([turn]) => turn)).toEqual([
      expect.objectContaining({ role: "user", text: "How is this machine doing?" }),
      expect.objectContaining({ role: "assistant", text: "Everything is healthy." }),
    ]);
  });

  it("keeps a dropped QR follow-up replayable through ninth-session admission", async () => {
    const ownerSettled = createDeferred();
    const releaseFollowUp = createDeferred();
    const followUpPresented = createDeferred();
    const engine = new SystemAgentChatEngine(
      {
        verifiedInference: requireVerifiedInferenceFixture(),
        deps: requireVerifiedInferenceDeps(),
        supportsQrCode: true,
      },
      {
        wizardDependencies: {
          runChannelSetupWizard: async (_channel, prompter) => {
            await prompter.qrCode?.({
              title: "Link a device",
              message: "Scan this QR code.",
              text: "https://example.test/pair",
              dismissed: ownerSettled.promise,
            });
            await releaseFollowUp.promise;
            const label = prompter.text({ message: "Device label" });
            followUpPresented.resolve();
            await label;
          },
        },
      },
    );
    const prompt = await engine.handle("connect telegram");
    const qrStepId = expectDefined(prompt.step?.id, "QR step id");
    const target = seededSession({ engine, lastUsedAt: 0 });
    const sessions = new Map<string, SystemAgentChatSession>([["lost-follow-up", target]]);
    const context = makeContext(sessions);
    ownerSettled.resolve();
    await expect(
      callChat(context, { sessionId: "lost-follow-up", pollStepId: qrStepId }),
    ).resolves.toMatchObject({ payload: { wizardSettling: true } });
    releaseFollowUp.resolve();
    await followUpPresented.promise;
    const historyBeforeObservation = engine.historyLength();
    await engine.resolveOperatorApproval(null, "queue-drain");
    expect(engine.historyLength()).toBe(historyBeforeObservation);

    const droppedReply = await callChat(context, {
      sessionId: "lost-follow-up",
      pollStepId: qrStepId,
    });
    expect(droppedReply.payload).toMatchObject({ step: { type: "text" } });
    if (!isRecord(droppedReply.payload) || !isRecord(droppedReply.payload.step)) {
      throw new Error("retained follow-up response must contain a step");
    }
    const followUpStepId = droppedReply.payload.step.id;
    const followUpText = droppedReply.payload.reply;
    if (typeof followUpStepId !== "string") {
      throw new Error("retained follow-up step must contain an id");
    }
    if (typeof followUpText !== "string") {
      throw new Error("retained follow-up response must contain reply text");
    }
    expect(
      transcriptStoreMocks.appendTranscriptTurn.mock.calls.filter(
        ([turn]) => turn.role === "assistant" && turn.text === followUpText,
      ),
    ).toHaveLength(1);
    expect(engine.hasPendingQrCode()).toBe(false);
    expect(engine.hasRecoverableQrReply()).toBe(true);

    target.lastUsedAt = 0;
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`ordinary-${index}`, seededSession({ lastUsedAt: index }));
    }
    stubEngineOverview();

    const admission = await callChat(context, { sessionId: "new-session" });
    expect(admission).toMatchObject({ ok: true });
    expect(sessions.has("lost-follow-up")).toBe(true);
    expect(sessions.has("new-session")).toBe(true);
    expect(sessions.size).toBe(9);
    await expect(
      callChat(context, { sessionId: "lost-follow-up", pollStepId: qrStepId }),
    ).resolves.toEqual(droppedReply);
    expect(
      transcriptStoreMocks.appendTranscriptTurn.mock.calls.filter(
        ([turn]) => turn.role === "assistant" && turn.text === followUpText,
      ),
    ).toHaveLength(1);

    await expect(
      callChat(context, {
        sessionId: "lost-follow-up",
        wizardAnswer: { stepId: followUpStepId, value: "OpenClaw" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(engine.hasRecoverableQrReply()).toBe(false);
    const persistedTurns = transcriptStoreMocks.appendTranscriptTurn.mock.calls.map(
      ([turn]) => turn,
    );
    expect(
      persistedTurns.filter(
        (turn) =>
          (turn.role === "assistant" && turn.text === followUpText) ||
          (turn.role === "user" && turn.text === "OpenClaw"),
      ),
    ).toEqual([
      expect.objectContaining({ role: "assistant", text: followUpText }),
      expect.objectContaining({ role: "user", text: "OpenClaw" }),
    ]);
    await expect(
      callChat(context, { sessionId: "lost-follow-up", pollStepId: qrStepId }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { code: "system_agent_session_invalidated" },
      },
    });
  });

  it("does not evict the newest active QR operation for each owner", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    for (let index = 0; index < 8; index += 1) {
      const protectedSession = seededSession({
        lastUsedAt: index,
        ownerKey: `device:owner-${index}`,
      });
      vi.spyOn(protectedSession.engine, "hasPendingQrCode").mockReturnValue(true);
      sessions.set(`protected-${index}`, protectedSession);
    }
    stubEngineOverview();

    const result = await callChat(makeContext(sessions), { sessionId: "new-session" });

    expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(sessions.size).toBe(8);
    expect([...sessions.keys()]).toEqual(
      Array.from({ length: 8 }, (_value, index) => `protected-${index}`),
    );
  });

  it("releases active QR capacity after an abandoned ownerless QR times out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const runnerFinished = createDeferred();
    const qrEngine = new SystemAgentChatEngine(
      {
        verifiedInference: requireVerifiedInferenceFixture(),
        deps: requireVerifiedInferenceDeps(),
        supportsQrCode: true,
      },
      {
        wizardDependencies: {
          runChannelSetupWizard: async (_channel, prompter, _beforePersistentApply, signal) => {
            const owner = new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("QR owner aborted", { cause: signal.reason })),
                { once: true },
              );
            });
            try {
              await prompter.qrCode?.({
                title: "Link a device",
                message: "Scan this QR code.",
                text: "https://example.test/pair",
                dismissed: owner,
              });
            } finally {
              runnerFinished.resolve();
            }
          },
        },
      },
    );

    try {
      await expect(qrEngine.handle("connect telegram")).resolves.toMatchObject({
        step: { type: "qr" },
      });
      await vi.advanceTimersByTimeAsync(SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS);
      await runnerFinished.promise;
      await Promise.resolve();
      expect(qrEngine.hasPendingQrCode()).toBe(true);
      await vi.advanceTimersByTimeAsync(SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS + 1);
      expect(qrEngine.hasPendingQrCode()).toBe(false);

      const timedOutSession = seededSession({
        engine: qrEngine,
        lastUsedAt: 0,
        ownerKey: "device:timed-out-owner",
      });
      const disposeTimedOut = vi.spyOn(qrEngine, "dispose");
      const sessions = new Map<string, SystemAgentChatSession>([["timed-out", timedOutSession]]);
      for (let index = 1; index < 8; index += 1) {
        const protectedSession = seededSession({
          lastUsedAt: index,
          ownerKey: `device:protected-owner-${index}`,
        });
        vi.spyOn(protectedSession.engine, "hasPendingQrCode").mockReturnValue(true);
        sessions.set(`protected-${index}`, protectedSession);
      }
      stubEngineOverview();

      await expect(
        callChat(makeContext(sessions), { sessionId: "new-session" }),
      ).resolves.toMatchObject({ ok: true });
      expect(disposeTimedOut).toHaveBeenCalledOnce();
      expect(sessions.has("timed-out")).toBe(false);
      expect(sessions.has("new-session")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds retained QR recovery sessions without evicting their live leases", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    for (let index = 0; index < 16; index += 1) {
      const recoverySession = seededSession({
        lastUsedAt: index,
        ownerKey: `device:recovery-owner-${index}`,
      });
      vi.spyOn(recoverySession.engine, "hasRecoverableQrReply").mockReturnValue(true);
      sessions.set(`recovery-${index}`, recoverySession);
    }
    stubEngineOverview();

    const result = await callChat(makeContext(sessions), { sessionId: "overflow" });

    expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(sessions.size).toBe(16);
    expect([...sessions.keys()]).toEqual(
      Array.from({ length: 16 }, (_value, index) => `recovery-${index}`),
    );
  });

  it("protects terminal QR delivery through audit, then expires abandoned retention", async () => {
    const ownerSettled = createDeferred();
    const runnerFinished = createDeferred();
    const auditStarted = createDeferred();
    const auditFinished = createDeferred();
    const releaseAudit = createDeferred();
    const qrEngine = new SystemAgentChatEngine(
      {
        verifiedInference: requireVerifiedInferenceFixture(),
        deps: requireVerifiedInferenceDeps(),
        supportsQrCode: true,
      },
      {
        wizardDependencies: {
          runChannelSetupWizard: async (_channel, prompter) => {
            await prompter.qrCode?.({
              title: "Link a device",
              message: "Scan this QR code.",
              text: "https://example.test/pair",
              dismissed: ownerSettled.promise,
            });
            runnerFinished.resolve();
          },
          appendAuditEntry: async () => {
            auditStarted.resolve();
            await releaseAudit.promise;
            auditFinished.resolve();
            return "audit-entry";
          },
        },
      },
    );
    const prompt = await qrEngine.handle("connect telegram");
    expect(prompt.step?.type).toBe("qr");
    const stepId = expectDefined(prompt.step?.id, "QR step id");
    ownerSettled.resolve();
    await runnerFinished.promise;
    await waitOneTask();
    expect(qrEngine.hasPendingQrCode()).toBe(true);

    const qrSession = seededSession({ engine: qrEngine, lastUsedAt: 0 });
    const disposeQr = vi.spyOn(qrEngine, "dispose");
    const sessions = new Map<string, SystemAgentChatSession>([["qr-applying", qrSession]]);
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`ordinary-${index}`, seededSession({ lastUsedAt: index }));
    }
    stubEngineOverview();

    await expect(qrEngine.pollStep(stepId)).resolves.toMatchObject({ wizardSettling: true });
    await auditStarted.promise;
    await expect(qrEngine.pollStep("stale-step")).rejects.toBeInstanceOf(
      SystemAgentWizardAnswerError,
    );
    const admission = callChat(makeContext(sessions), { sessionId: "new-session" });
    await waitOneTask();

    expect(disposeQr).not.toHaveBeenCalled();
    expect(await admission).toMatchObject({ ok: true });
    expect(sessions.has("qr-applying")).toBe(true);
    expect(sessions.has("ordinary-1")).toBe(false);

    releaseAudit.resolve();
    await auditFinished.promise;
    await waitOneTask();
    expect(qrEngine.hasPendingQrCode()).toBe(true);

    const retainedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(retainedAt + SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS + 1);
    expect(qrEngine.hasPendingQrCode()).toBe(false);
    await expect(
      callChat(makeContext(sessions), { sessionId: "after-retention" }),
    ).resolves.toMatchObject({ ok: true });
    expect(disposeQr).toHaveBeenCalledOnce();
    expect(sessions.has("qr-applying")).toBe(false);
  });
});
