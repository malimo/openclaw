import "./chat-engine.mocks.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  fakeOverviewLoader,
  mocks,
  classifySystemAgentApprovalText,
  useTempStateDir,
  configSnapshot,
  createAmbientVerifiedBinding,
  SystemAgentChatEngine,
  CANCEL_HINT,
  countCancelHints,
  expectDefined,
  SystemAgentInferenceUnavailableError,
  SystemAgentWizardAnswerError,
  type OpenClawConfig,
  type WizardPrompter,
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

  it("recommends the confirm option matching the initial value", async () => {
    let enabled: boolean | undefined;
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        enabled = await prompter.confirm({
          message: "Enable delegated auth?",
          initialValue: false,
        });
      },
    });

    const confirmStep = await engine.handle("connect telegram");

    expect(confirmStep.question).toEqual({
      id: expect.any(String),
      header: "Confirm",
      question: "Enable delegated auth?",
      options: [
        { label: "Yes", reply: "yes" },
        { label: "No", reply: "no", recommended: true },
      ],
    });

    await engine.handle("no");
    expect(enabled).toBe(false);

    const defaultEngine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.confirm({ message: "Continue?" });
      },
    });

    const defaultConfirmStep = await defaultEngine.handle("connect telegram");

    expect(defaultConfirmStep.question?.options).toEqual([
      { label: "Yes", reply: "yes", recommended: true },
      { label: "No", reply: "no" },
    ]);
    await defaultEngine.handle("yes");
  });

  it("rejects non-decimal menu numbers in hosted wizard choices", async () => {
    useTempStateDir();
    const runs: unknown[] = [];
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel, prompter) => {
        runs.push(
          await prompter.select({
            message: "DM mode",
            options: [
              { value: "pair", label: "Pairing" },
              { value: "open", label: "Open" },
            ],
          }),
        );
        runs.push(
          await prompter.multiselect({
            message: "Features",
            options: [
              { value: "alerts", label: "Alerts" },
              { value: "logs", label: "Logs" },
            ],
          }),
        );
      },
    });
    expect((await engine.handle("connect telegram")).text).toContain("1. Pairing");
    expect((await engine.handle("1e0")).text).toContain("I could not match that answer.");
    expect(runs).toEqual([]);
    expect((await engine.handle("1")).text).toContain("1. Alerts");
    expect((await engine.handle("0x1")).text).toContain("I could not match that answer.");
    expect(await engine.handle("1,2")).toHaveProperty(
      "text",
      expect.stringContaining("telegram is configured"),
    );
    expect(runs).toEqual(["pair", ["alerts", "logs"]]);
  });

  it("marks sensitive hosted-wizard replies and auto-advances notes", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.note("Before entering the token, open the provider console.");
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });

    const tokenStep = await engine.handle("connect telegram");

    expect(tokenStep.text).toContain("Before entering the token");
    expect(tokenStep.text).toContain("Bot token");
    expect(tokenStep.sensitive).toBe(true);
    expect(tokenStep.wizardInputPending).toBe(true);
  });

  it("marks a non-card hosted-wizard step as pending input", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot label" });
      },
    });

    const textStep = await engine.handle("connect telegram");

    expect(textStep.text).toContain("Bot label");
    expect(textStep.question).toBeUndefined();
    expect(textStep.sensitive).toBeUndefined();
    expect(textStep.wizardInputPending).toBe(true);
  });

  it("routes sensitive CLI wizard prompts to the masked channel setup flow", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "cli",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("Sensitive input is not accepted");
    expect(reply.text).toContain("openclaw channels add --channel telegram");
    expect(reply.sensitive).toBeUndefined();

    const handoff = await engine.handle("open channel wizard");
    expect(handoff.action).toBe("open-setup");
    expect(handoff.handoff).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "telegram",
    });

    const channelRequired = await engine.handle("open channel wizard");
    expect(channelRequired.action).toBe("none");
    expect(channelRequired.text).toContain("Which channel");

    const selectedChannel = await engine.handle("slack");
    expect(selectedChannel.action).toBe("open-setup");
    expect(selectedChannel.handoff).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
  });

  it("clears a sensitive channel before a different wizard session starts", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "cli",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token", sensitive: true });
      },
      runSkillsSetupWizard: async () => {},
    });

    const sensitive = await engine.handle("connect telegram");
    expect(sensitive.text).toContain("masked terminal wizard for telegram");
    await engine.handle("configure skills");

    const handoff = await engine.handle("open channel wizard");
    expect(handoff.action).toBe("none");
    expect(handoff.handoff).toBeUndefined();
    expect(handoff.text).toContain("Which channel");
  });

  it("routes inference setup out of both CLI and gateway sessions", async () => {
    const common = {
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    };
    const cli = new SystemAgentChatEngine({ ...common, surface: "cli" });
    for (const command of ["open setup wizard", "open classic wizard"]) {
      const cliReply = await cli.handle(command);
      expect(cliReply.action).toBe("none");
      expect(cliReply.handoff).toBeUndefined();
      expect(cliReply.text).toContain("run `openclaw onboard`");
    }

    const gateway = new SystemAgentChatEngine({ ...common, surface: "gateway" });
    const gatewayReply = await gateway.handle("open setup wizard");
    expect(gatewayReply.action).toBe("none");
    expect(gatewayReply.handoff).toBeUndefined();
    // The gateway surface has real setup screens, so the reply names them
    // rather than sending the reader to a terminal they may not have.
    expect(gatewayReply.text).toContain("Settings");
    expect(gatewayReply.text).toContain("change providers from a shell");
    expect(gatewayReply.text).toContain("machine running OpenClaw");
    expect(gatewayReply.text).not.toContain("does the same job");
    expect(gatewayReply.text).not.toContain("Exit OpenClaw");
  });

  it("keeps hosted-wizard validation errors on the current prompt", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({
          message: "Port",
          validate: (value) => (value === "18789" ? undefined : "Enter port 18789"),
        });
      },
    });

    const prompt = await engine.handle("connect telegram");
    expect(prompt.text).toContain("Port");
    const invalid = await engine.handle("banana");
    expect(invalid.text).toContain("Enter port 18789");
    expect(invalid.text).toContain("Port");
    expect(countCancelHints(invalid.text)).toBe(1);
    expect(invalid.text.endsWith(CANCEL_HINT)).toBe(true);
    const done = await engine.handle("18789");
    expect(done.text).toContain("telegram is configured");
  });

  it("hints cancel once per message, only while a step awaits an answer", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.note("Open the linked-devices screen.", "Step 1");
        await prompter.note("Scan the code shown next.", "Step 2");
        await prompter.note("Keep the phone online.", "Step 3");
        await prompter.text({ message: "Phone number" });
        await prompter.note("Linked.", "Step 4");
      },
    });

    // Three auto-answered notes concatenate into the prompt's message; the hint
    // is the message's, not each step's.
    const prompt = await engine.handle("connect telegram");
    expect(prompt.text).toContain("Step 3");
    expect(prompt.text).toContain("Phone number");
    expect(countCancelHints(prompt.text)).toBe(1);
    expect(prompt.text.endsWith(CANCEL_HINT)).toBe(true);
    expect(engine.historySince(0).at(-1)).toEqual({ role: "assistant", text: prompt.text });

    const done = await engine.handle("+15551230000");
    expect(done.text).toContain("Step 4");
    expect(done.text).toContain("telegram is configured");
    expect(countCancelHints(done.text)).toBe(0);
  });

  it("drops the cancel hint from the cancellation message", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const prompt = await engine.handle("connect discord");
    expect(countCancelHints(prompt.text)).toBe(1);

    const cancelled = await engine.handle("cancel");
    expect(cancelled.text).toContain("cancelled");
    expect(countCancelHints(cancelled.text)).toBe(0);
  });

  it("cancels a hosted wizard mid-flight", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const tokenStep = await engine.handle("connect discord");
    expect(tokenStep.text).toContain("Bot token");

    const cancelled = await engine.handle("cancel");
    expect(cancelled.text).toContain("cancelled");
  });

  it("voids a stale host proposal before an exact wizard, including cancellation", async () => {
    const runConfigSet = vi.fn(async () => {});
    const runAgentTurn = vi.fn(async (params: { approvalArmed: boolean }) => ({
      text: params.approvalArmed ? "unexpected approval" : "No pending change.",
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("connect discord");
    const cancelled = await engine.handle("cancel");
    const laterApproval = await engine.handle("yes");

    expect(cancelled.text).toContain("cancelled");
    expect(engine.hasPendingProposal()).toBe(false);
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(runAgentTurn.mock.calls.at(-1)?.[0]?.approvalArmed).toBe(false);
    expect(laterApproval.text).toContain("No pending change");
  });

  it("voids a stale agent proposal after an exact wizard completes", async () => {
    useTempStateDir();
    const armed: boolean[] = [];
    const runAgentTurn = vi.fn(
      async (params: {
        approvalArmed: boolean;
        session: { proposalRef: { current?: string } };
      }) => {
        armed.push(params.approvalArmed);
        if (armed.length === 1) {
          params.session.proposalRef.current = "stale-operation";
        }
        return { text: "No pending change." };
      },
    );
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("prepare a change for me");
    await engine.handle("connect telegram");
    const done = await engine.handle("123:abc");
    await engine.handle("yes");

    expect(done.text).toContain("telegram is configured");
    expect(armed).toEqual([false, false]);
  });

  it("strips a sensitive step's prefilled value but keeps a plain one", async () => {
    useTempStateDir();
    const makeEngine = (sensitive: boolean) =>
      new SystemAgentChatEngine({
        surface: "gateway",
        runAgentTurn: async () => null,
        planWithAssistant: async () => null,
        deps: { loadOverview: fakeOverviewLoader() },
        runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
          await prompter.text({
            message: "Bot token",
            initialValue: "123456:REAL-SECRET",
            ...(sensitive ? { sensitive: true } : {}),
          });
        },
      });

    const secret = await makeEngine(true).handle("connect telegram");
    expect(secret.step?.sensitive).toBe(true);
    expect(secret.step).not.toHaveProperty("initialValue");
    expect(JSON.stringify(secret)).not.toContain("REAL-SECRET");

    // Redaction is scoped to sensitive steps; ordinary prefill still reaches
    // clients, otherwise every edit-in-place prompt would lose its default.
    const plain = await makeEngine(false).handle("connect telegram");
    expect(plain.step?.initialValue).toBe("123456:REAL-SECRET");
  });

  it("omits the wizard step outside an awaiting hosted wizard", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => ({ text: "*click* Everything looks healthy." }),
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const ordinary = await engine.handle("how is my setup looking?");
    expect(ordinary.step).toBeUndefined();

    const awaiting = await engine.handle("connect telegram");
    expect(awaiting.step?.type).toBe("text");

    const done = await engine.handle("123:abc");
    expect(done.text).toContain("telegram is configured");
    expect(done.step).toBeUndefined();
  });

  it("submits a typed answer directly and records the server-owned option label", async () => {
    useTempStateDir();
    let selected: unknown;
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        selected = await prompter.select({
          message: "Choose one",
          options: [
            { value: "alpha", label: "Alpha" },
            { value: "beta", label: "Beta" },
          ],
        });
      },
    });

    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step?.id, "expected an active wizard step");
    await engine.answerWizard({ stepId, value: "beta" });

    expect(selected).toBe("beta");
    expect(engine.historySince(0)).toContainEqual({ role: "user", text: "Beta" });
  });

  it("cancels the current hosted wizard through a typed direct action", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step?.id, "expected an active wizard step");
    const cancelled = await engine.cancelWizard({ stepId });

    expect(cancelled.text).toContain("cancelled");
    expect(cancelled.step).toBeUndefined();
    expect(cancelled.wizardInputPending).toBeUndefined();
    expect(engine.historySince(0)).toContainEqual({ role: "user", text: "Cancel" });
  });

  it("cancels the local hosted wizard after its inference binding drifts", async () => {
    useTempStateDir();
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
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        loadOverview: fakeOverviewLoader(),
      },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step?.id, "expected an active wizard step");
    currentConfig = changedConfig;
    const cancelled = await engine.cancelWizard({ stepId });

    expect(cancelled.text).toContain("cancelled");
    expect(cancelled.step).toBeUndefined();
  });

  it("rejects a stale typed cancel without changing the active step", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step?.id, "expected an active wizard step");
    await expect(engine.cancelWizard({ stepId: "stale-step" })).rejects.toBeInstanceOf(
      SystemAgentWizardAnswerError,
    );
    const cancelled = await engine.cancelWizard({ stepId });

    expect(cancelled.text).toContain("cancelled");
  });

  it("rejects a stale structured answer without changing the active step", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const prompt = await engine.handle("connect telegram");
    await expect(
      engine.answerWizard({ stepId: "stale-step", value: "ignored" }),
    ).rejects.toBeInstanceOf(SystemAgentWizardAnswerError);
    const stepId = expectDefined(prompt.step?.id, "expected an active wizard step");
    const done = await engine.answerWizard({ stepId, value: "123:abc" });

    expect(done.step).toBeUndefined();
    expect(JSON.stringify(engine.historySince(0))).not.toContain("ignored");
  });

  it("redacts a sensitive structured answer from engine history", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });

    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step?.id, "expected an active wizard step");
    await engine.answerWizard({ stepId, value: "raw-secret-value" });

    expect(engine.historySince(0)).toContainEqual({ role: "user", text: "<redacted secret>" });
    expect(JSON.stringify(engine.historySince(0))).not.toContain("raw-secret-value");
  });

  it("keeps the numbered text grammar for text-only wizard clients", async () => {
    useTempStateDir();
    let selected: unknown;
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        selected = await prompter.select({
          message: "Choose one",
          options: [
            { value: "alpha", label: "Alpha" },
            { value: "beta", label: "Beta" },
          ],
        });
      },
    });

    await engine.handle("connect telegram");
    await engine.handle("2");

    expect(selected).toBe("beta");
  });
});
