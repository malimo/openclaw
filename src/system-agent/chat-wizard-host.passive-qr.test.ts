import "./chat-engine.mocks.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  fakeOverviewLoader,
  mocks,
  configSnapshot,
  createAmbientVerifiedBinding,
  SystemAgentChatEngine,
  expectDefined,
  SystemAgentInferenceUnavailableError,
  type OpenClawConfig,
} from "./chat-engine.test-support.js";
import type { ChatWizardHostDependencies } from "./chat-wizard-host.js";
import { SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS } from "./chat-wizard-host.js";

const QR_TEXT = "https://example.test/pair";

function createQrEngine(
  runChannelSetupWizard: NonNullable<ChatWizardHostDependencies["runChannelSetupWizard"]>,
) {
  return new SystemAgentChatEngine({
    runAgentTurn: async () => null,
    planWithAssistant: async () => null,
    deps: { loadOverview: fakeOverviewLoader() },
    supportsQrCode: true,
    runChannelSetupWizard,
    appendAuditEntry: async () => "",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SystemAgentChatEngine wizard", () => {
  it("hosts QR setup as a passive owner-controlled wizard step", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: owner,
      });
    });

    const prompt = await engine.handle("connect telegram");
    expect(prompt).toMatchObject({
      wizardSettling: true,
      step: {
        id: expect.any(String),
        type: "qr",
        qrDataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
        expiresInMs: expect.any(Number),
        executor: "client",
      },
    });
    expect(prompt).not.toHaveProperty("wizardInputPending");
    expect(prompt.question).toBeUndefined();
    expect(prompt.text).not.toContain("Say `cancel`");
    const stepId = expectDefined(prompt.step, "QR step").id;

    const guidance = await engine.handle("continue");
    expect(guidance.text).toContain("Setup continues automatically");
    expect(guidance.step?.id).toBe(stepId);
    await expect(engine.answerWizard({ stepId })).rejects.toThrow(
      "QR setup continues automatically",
    );
    settleOwner();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const retainedAt = Date.now();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(retainedAt + SYSTEM_AGENT_HOSTED_WIZARD_TIMEOUT_MS + 1);
    expect(engine.hasPendingQrCode()).toBe(false);
    now.mockRestore();
    const done = await engine.handle("status");
    expect(done.text).toContain("telegram is configured");
    expect(done.step).toBeUndefined();
    expect(engine.hasPendingQrCode()).toBe(false);
  });

  it("polls owner completion without answering the QR step", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let runnerReachedGate = false;
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: owner,
      });
      runnerReachedGate = true;
      await runnerGate;
    });

    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step, "QR step").id;
    settleOwner();
    await vi.waitFor(() => expect(runnerReachedGate).toBe(true));

    const settling = await engine.pollStep(stepId);
    expect(settling).toMatchObject({ wizardSettling: true });
    expect(settling).not.toHaveProperty("step");

    releaseRunner();
    expect(engine.hasPendingQrCode()).toBe(true);
    let completed: Awaited<ReturnType<SystemAgentChatEngine["pollStep"]>> | undefined;
    await vi.waitFor(async () => {
      const reply = await engine.pollStep(stepId);
      expect(reply.wizardSettling).not.toBe(true);
      completed = reply;
    });
    const terminal = expectDefined(completed, "terminal QR reply");
    expect(terminal.text).toContain("telegram is configured");
    expect(terminal).not.toHaveProperty("wizardSettling");
    expect(terminal).not.toHaveProperty("step");
    expect(engine.hasPendingQrCode()).toBe(false);
  });

  it("projects a successor QR through the last client-known poll step", async () => {
    const firstOwner = createDeferred<void>();
    const secondOwner = createDeferred<void>();
    const secondQrStarted = createDeferred<void>();
    const releaseSecondQr = createDeferred<void>();
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link the first device",
        message: "Scan the first QR code.",
        text: `${QR_TEXT}/first`,
        dismissed: firstOwner.promise,
        expiresAtMs: Date.now() + 60_000,
      });
      secondQrStarted.resolve();
      await releaseSecondQr.promise;
      const secondQr = prompter.qrCode?.({
        title: "Link the replacement device",
        message: "Scan the replacement QR code.",
        text: `${QR_TEXT}/second`,
        dismissed: secondOwner.promise,
        expiresAtMs: Date.now() + 60_000,
      });
      await secondQr;
    });

    const first = await engine.handle("connect telegram");
    const firstStepId = expectDefined(first.step, "first QR step").id;
    firstOwner.resolve();
    await secondQrStarted.promise;
    const settling = await engine.pollStep(firstStepId);
    expect(settling).toMatchObject({ wizardSettling: true });
    expect(settling).not.toHaveProperty("step");
    releaseSecondQr.resolve();

    let successor: Awaited<ReturnType<SystemAgentChatEngine["pollStep"]>> | undefined;
    await vi.waitFor(async () => {
      const reply = await engine.pollStep(firstStepId);
      expect(reply.step?.type).toBe("qr");
      expect(reply.step?.id).not.toBe(firstStepId);
      successor = reply;
    });
    const second = expectDefined(successor, "successor QR reply");
    const secondStep = expectDefined(second.step, "successor QR step");
    const firstExpiresInMs = expectDefined(secondStep.expiresInMs, "successor QR expiry");

    const retried = await engine.pollStep(firstStepId);
    expect(retried.step).toMatchObject({
      id: secondStep.id,
      type: "qr",
      qrDataUrl: secondStep.qrDataUrl,
    });
    expect(expectDefined(retried.step?.expiresInMs, "retried QR expiry")).toBeLessThanOrEqual(
      firstExpiresInMs,
    );

    await expect(engine.pollStep(secondStep.id)).resolves.toMatchObject({
      step: { id: secondStep.id, type: "qr" },
    });
    await expect(engine.pollStep(firstStepId)).rejects.toThrow("stale step");
    await expect(engine.cancelWizard({ stepId: firstStepId })).rejects.toThrow("stale step");

    secondOwner.resolve();
    await vi.waitFor(async () => {
      const reply = await engine.pollStep(secondStep.id);
      expect(reply.wizardSettling).not.toBe(true);
      expect(reply.step).toBeUndefined();
    });
  });

  it("cancels a successor QR through an unacknowledged predecessor cursor", async () => {
    const firstOwner = createDeferred<void>();
    const secondOwner = createDeferred<void>();
    const secondQrStarted = createDeferred<void>();
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link the first device",
        message: "Scan the first QR code.",
        text: `${QR_TEXT}/first`,
        dismissed: firstOwner.promise,
      });
      const secondQr = prompter.qrCode?.({
        title: "Link the replacement device",
        message: "Scan the replacement QR code.",
        text: `${QR_TEXT}/second`,
        dismissed: secondOwner.promise,
      });
      secondQrStarted.resolve();
      await secondQr;
    });

    const first = await engine.handle("connect telegram");
    const firstStepId = expectDefined(first.step, "first QR step").id;
    firstOwner.resolve();
    await secondQrStarted.promise;
    await vi.waitFor(async () => {
      const successor = await engine.pollStep(firstStepId);
      expect(successor.step?.type).toBe("qr");
      expect(successor.step?.id).not.toBe(firstStepId);
    });

    const cancelled = await engine.cancelWizard({ stepId: firstStepId });
    expect(cancelled.text).toContain("setup cancelled");
    expect(cancelled.step).toBeUndefined();
    expect(JSON.stringify(cancelled)).not.toContain("data:image/png");
    expect(engine.hasPendingQrCode()).toBe(false);
  });

  it("verifies a passive QR write once before retaining its terminal reply", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let runnerReachedGate = false;
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: owner,
      });
      runnerReachedGate = true;
      await runnerGate;
    });

    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step, "QR step").id;
    settleOwner();
    await vi.waitFor(() => expect(runnerReachedGate).toBe(true));
    await expect(engine.pollStep(stepId)).resolves.toMatchObject({ wizardSettling: true });

    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      path: "/tmp/openclaw.json",
      hash: "invalid",
      config: {},
      sourceConfig: {},
      issues: [{ path: "channels.signal", message: "invalid transport" }],
    } as never);
    releaseRunner();
    let completed: Awaited<ReturnType<SystemAgentChatEngine["pollStep"]>> | undefined;
    await vi.waitFor(async () => {
      const reply = await engine.pollStep(stepId);
      expect(reply.wizardSettling).not.toBe(true);
      completed = reply;
    });

    const terminal = expectDefined(completed, "verified terminal QR reply");
    expect(terminal.text).toContain("telegram is configured");
    expect(terminal.text).toContain("openclaw.json failed validation");
    expect(terminal.text).toContain("openclaw doctor --fix");
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(engine.hasPendingQrCode()).toBe(false);
  });

  it.each([
    {
      name: "chat command",
      cancel: (engine: SystemAgentChatEngine) => engine.handle("cancel"),
    },
    {
      name: "typed direct action",
      cancel: (engine: SystemAgentChatEngine, stepId: string) => engine.cancelWizard({ stepId }),
    },
  ])("cancels active QR setup through a $name", async ({ cancel }) => {
    let cleanupStarted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const engine = createQrEngine(async (_channel, prompter) => {
      try {
        await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code and approve the device.",
          text: QR_TEXT,
          dismissed: new Promise<void>(() => {}),
        });
      } finally {
        cleanupStarted = true;
        await cleanup;
      }
    });
    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step, "QR step").id;

    const cancellation = cancel(engine, stepId);
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));
    let completed = false;
    void cancellation.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseCleanup();
    const cancelled = await cancellation;
    expect(cancelled.text).toContain("setup cancelled");
    expect(cancelled).not.toHaveProperty("wizardInputPending");
    expect(cancelled).not.toHaveProperty("step");
  });

  it("keeps cancellation reachable while an externally owned QR is pending", async () => {
    let cleanupStarted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const engine = createQrEngine(async (_channel, prompter, _beforePersistentApply, signal) => {
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
          message: "Scan this QR code and approve the device.",
          text: QR_TEXT,
          dismissed: owner,
          expiresAtMs: Date.now() + 60_000,
        });
        await owner;
      } finally {
        cleanupStarted = true;
        await cleanup;
      }
    });
    const prompt = await engine.handle("connect telegram");
    expectDefined(prompt.step, "QR step");

    const cancellation = engine.handle("cancel");
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));
    releaseCleanup();
    expect((await cancellation).text).toContain("setup cancelled");
  });

  it("rejects generic acknowledgements while the QR owner settles", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let runnerReachedGate = false;
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: owner,
        expiresAtMs: Date.now() + 60_000,
      });
      await owner;
      runnerReachedGate = true;
      await runnerGate;
    });
    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step, "QR step").id;

    await expect(engine.answerWizard({ stepId })).rejects.toThrow(
      "QR setup continues automatically",
    );
    settleOwner();
    await vi.waitFor(() => expect(runnerReachedGate).toBe(true));

    await expect(engine.answerWizard({ stepId })).rejects.toThrow(
      "No hosted wizard is awaiting an answer",
    );

    releaseRunner();
    expect(engine.hasPendingQrCode()).toBe(true);
    await vi.waitFor(async () => {
      const reply = await engine.pollStep(stepId);
      expect(reply.wizardSettling).not.toBe(true);
    });
    expect(engine.hasPendingQrCode()).toBe(false);
  });

  it("keeps typed cancellation reachable after the QR owner settles", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    let runnerReachedCleanup = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: owner,
        expiresAtMs: Date.now() + 60_000,
      });
      runnerReachedCleanup = true;
      await cleanup;
    });
    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step, "QR step").id;

    settleOwner();
    await vi.waitFor(() => expect(runnerReachedCleanup).toBe(true));

    const cancellation = engine.cancelWizard({ stepId });
    releaseCleanup();
    expect((await cancellation).text).toContain("setup cancelled");
  });

  it("cancels an externally owned QR after its presentation deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    let abortObserved = false;
    const engine = createQrEngine(async (_channel, prompter, _beforePersistentApply, signal) => {
      try {
        await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code and approve the device.",
          text: QR_TEXT,
          dismissed: new Promise<void>(() => {}),
          expiresAtMs: 1_800_000_001_000,
        });
      } finally {
        abortObserved = signal.aborted;
      }
    });
    await engine.handle("connect telegram");
    vi.setSystemTime(1_800_000_001_000);

    const cancelled = await engine.handle("cancel");
    expect(abortObserved).toBe(true);
    expect(cancelled.text).toContain("setup cancelled");
  });

  it("retains a follow-up step without keeping the QR reservation", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    const releaseFollowUp = createDeferred();
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: owner,
        expiresAtMs: Date.now() + 60_000,
      });
      await releaseFollowUp.promise;
      await prompter.text({ message: "Device label" });
    });

    const prompt = await engine.handle("connect telegram");
    const qrStepId = expectDefined(prompt.step, "QR step").id;
    settleOwner();
    await expect(engine.pollStep(qrStepId)).resolves.toMatchObject({ wizardSettling: true });
    releaseFollowUp.resolve();

    let followUp: Awaited<ReturnType<SystemAgentChatEngine["pollStep"]>> | undefined;
    await vi.waitFor(async () => {
      followUp = await engine.pollStep(qrStepId);
      expect(followUp.step?.type).toBe("text");
    });
    expect(engine.hasPendingQrCode()).toBe(false);
    await engine.answerWizard({
      stepId: expectDefined(followUp?.step, "follow-up step").id,
      value: "OpenClaw",
    });
  });

  it("waits for an owner-settled QR runner before disposal completes", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let runnerReachedApply = false;
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: owner,
        expiresAtMs: Date.now() + 60_000,
      });
      runnerReachedApply = true;
      await runnerGate;
    });

    await engine.handle("connect telegram");
    settleOwner();
    await vi.waitFor(() => expect(runnerReachedApply).toBe(true));

    let disposed = false;
    const disposal = engine.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseRunner();
    await disposal;
    expect(disposed).toBe(true);
  });

  it("retains QR cleanup after inference loss clears the active bridge", async () => {
    const baseConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig: OpenClawConfig = baseConfig;
    let cleanupStarted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      supportsQrCode: true,
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        loadOverview: fakeOverviewLoader(),
      },
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
            message: "Scan this QR code and approve the device.",
            text: QR_TEXT,
            dismissed: owner,
          });
        } finally {
          cleanupStarted = true;
          await cleanup;
        }
      },
    });

    await engine.handle("connect telegram");
    currentConfig = changedConfig;
    await expect(engine.handle("status")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));

    let disposed = false;
    const disposal = engine.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseCleanup();
    await disposal;
    expect(disposed).toBe(true);
  });

  it("scrubs an expired QR while its owner remains cancellable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: new Promise<void>(() => {}),
        expiresAtMs: 1_800_000_001_000,
      });
    });

    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step, "QR step").id;
    vi.setSystemTime(1_800_000_001_000);

    await expect(engine.answerWizard({ stepId })).rejects.toThrow(
      "No hosted wizard is awaiting an answer",
    );
    expect(engine.hasPendingQrCode()).toBe(true);
    await engine.handle("cancel");
  });

  it("replaces scan instructions when the QR expires before its first projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: new Promise<void>(() => {}),
        expiresAtMs: 1_800_000_000_000,
      });
    });

    const prompt = await engine.handle("connect telegram");

    expect(prompt.text).toBe(
      "This setup QR code expired. Setup is still finishing the attempt automatically.",
    );
    expect(prompt.text).not.toContain("Scan");
    expect(prompt.step).toBeUndefined();
    expect(prompt.wizardSettling).toBe(true);
    await engine.handle("cancel");
  });

  it("waits for automatic-expiry cleanup before routing an ordinary turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    let cleanupStarted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const runAgentTurn = vi.fn(async () => ({ text: "Ordinary turn completed." }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      supportsQrCode: true,
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
            message: "Scan this QR code and approve the device.",
            text: QR_TEXT,
            dismissed: owner,
            expiresAtMs: 1_800_000_001_000,
          });
        } finally {
          cleanupStarted = true;
          await cleanup;
        }
      },
    });

    await engine.handle("connect telegram");
    await vi.advanceTimersByTimeAsync(1_000 + 25 * 60 * 1_000);
    const ordinaryTurn = engine.handle("How is everything looking?");
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));
    expect(runAgentTurn).not.toHaveBeenCalled();

    releaseCleanup();
    await expect(ordinaryTurn).resolves.toMatchObject({ text: "Ordinary turn completed." });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });
});
