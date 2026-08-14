// Wizard session tests cover session creation and state transitions.

import { describe, expect, test, vi } from "vitest";
import { QR_PNG_DATA_URL_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/qr.js";
import type { WizardPrompter } from "./prompts.js";
import { WizardSession, wizardStepAwaitsInput, type WizardStep } from "./session.js";

const QR_TEXT = "https://example.test/pair";
const QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const qrImageMocks = vi.hoisted(() => ({
  renderQrPngDataUrlWithinLimit: vi.fn(async () => QR_DATA_URL),
}));

vi.mock("../media/qr-image.js", () => ({
  renderQrPngDataUrlWithinLimit: qrImageMocks.renderQrPngDataUrlWithinLimit,
}));

function noteRunner() {
  return new WizardSession(async (prompter) => {
    await prompter.note("Welcome");
    const name = await prompter.text({ message: "Name" });
    await prompter.note(`Hello ${name}`);
  });
}

function qrStep(): WizardStep {
  return {
    id: "qr-step",
    type: "qr",
    executor: "client",
    qrDataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    qrExpiresAtMs: Date.now() + 60_000,
  };
}

function presentQr(prompter: WizardPrompter, dismissed: Promise<unknown>) {
  return prompter.qrCode?.({
    title: "Link a device",
    message: "Scan this QR code and approve the device.",
    text: QR_TEXT,
    expiresAtMs: Date.now() + 60_000,
    dismissed,
  });
}

function createQrSession(
  run: ConstructorParameters<typeof WizardSession>[0],
  options: ConstructorParameters<typeof WizardSession>[1] = {},
) {
  return new WizardSession(run, { supportsQrCode: true, ...options });
}

describe("WizardSession", () => {
  test.each([
    ["select", undefined, true],
    ["multiselect", undefined, true],
    ["text", undefined, true],
    ["confirm", undefined, true],
    ["action", "client", true],
    ["action", "gateway", false],
    ["qr", "client", false],
    ["note", undefined, false],
    ["progress", undefined, false],
  ] as const satisfies ReadonlyArray<
    readonly [WizardStep["type"], WizardStep["executor"], boolean]
  >)("classifies whether %s/%s awaits user input", (type, executor, expected) => {
    expect(wizardStepAwaitsInput({ type, executor })).toBe(expected);
  });

  test("settles passive QR steps only through their producer owner", async () => {
    let producer!: WizardSession;
    const session = new WizardSession(async (_prompter, _signal, owner) => {
      producer = owner;
      await owner.awaitAnswer(qrStep());
    });

    const next = await session.next();
    expect(next.step?.type).toBe("qr");
    await expect(session.answer("qr-step", true)).rejects.toThrow(
      "wizard: QR steps settle through their presentation owner",
    );
    expect(session.getStatus()).toBe("running");
    expect((await session.next()).step?.id).toBe("qr-step");
    expect(producer.settleQrStep("qr-step")).toBe(true);
    expect(next.step?.qrDataUrl).toBeUndefined();
    await expect(session.next()).resolves.toMatchObject({ done: true, status: "done" });
  });

  test.each(["done", "error"] as const)(
    "scrubs a delivered QR when its runner reaches %s",
    async (outcome) => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const session = new WizardSession(async (_prompter, _signal, owner) => {
        owner.pushStep(qrStep());
        await gate;
        if (outcome === "error") {
          throw new Error("setup failed");
        }
      });

      const delivered = await session.next();
      expect(delivered.step?.type).toBe("qr");
      finish();
      await session.whenSettled();

      expect(delivered.step?.qrDataUrl).toBeUndefined();
      await expect(session.next()).resolves.toMatchObject({
        done: true,
        status: outcome,
      });
    },
  );

  test("steps progress in order", async () => {
    const session = noteRunner();

    const first = await session.next();
    expect(first.done).toBe(false);
    expect(first.step?.type).toBe("note");

    const secondPeek = await session.next();
    expect(secondPeek.step?.id).toBe(first.step?.id);

    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);

    const second = await session.next();
    expect(second.done).toBe(false);
    expect(second.step?.type).toBe("text");

    if (!second.step) {
      throw new Error("expected second step");
    }
    await session.answer(second.step.id, "Peter");

    const third = await session.next();
    expect(third.step?.type).toBe("note");

    if (!third.step) {
      throw new Error("expected third step");
    }
    await session.answer(third.step.id, null);

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("plain output is a client note with plain format", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.plain?.('{"ok":true}');
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected plain note");
    }
    expect(first.step.type).toBe("note");
    expect(first.step.message).toBe('{"ok":true}');
    expect(first.step.format).toBe("plain");
    await session.answer(first.step.id, null);
    const done = await session.next();
    expect(done.done).toBe(true);
  });

  test("returns the exact prepared model only on the terminal result", async () => {
    const session = new WizardSession(async (_prompter, _signal, owner) => {
      owner.setPreparedModelRef("ollama/qwen3:0.6b");
    });

    await expect(session.next()).resolves.toEqual({
      done: true,
      status: "done",
      preparedModelRef: "ollama/qwen3:0.6b",
    });
  });

  test("does not expose a prepared model when the wizard fails", async () => {
    const session = new WizardSession(async (_prompter, _signal, owner) => {
      owner.setPreparedModelRef("ollama/qwen3:0.6b");
      throw new Error("activation setup failed");
    });

    await expect(session.next()).resolves.toMatchObject({
      done: true,
      status: "error",
      error: "Error: activation setup failed",
    });
    expect(await session.next()).not.toHaveProperty("preparedModelRef");
  });

  test("attaches an explicit browser destination to the next client step", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.openUrl?.("https://provider.example/oauth?state=state-1");
      await prompter.text({ message: "Paste the redirect URL" });
    });

    const first = await session.next();
    expect(first.step?.externalUrl).toBe("https://provider.example/oauth?state=state-1");
    expect(first.step?.type).toBe("text");
    if (!first.step) {
      throw new Error("expected provider sign-in step");
    }
    await session.answer(first.step.id, "http://localhost/callback?code=done");
    expect((await session.next()).status).toBe("done");
  });

  test("carries device-code presentation without parsing provider prose", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.openUrl?.("https://provider.example/device");
      await prompter.deviceCode?.({
        title: "Provider sign-in",
        code: "ABCD-1234",
        expiresInMinutes: 15,
        message: "Enter this one-time code in your browser.",
      });
    });

    const first = await session.next();
    expect(first.step).toMatchObject({
      type: "note",
      title: "Provider sign-in",
      message:
        "Enter this one-time code in your browser.\nCode: ABCD-1234\nCode expires in 15 minutes. Never share it.",
      externalUrl: "https://provider.example/device",
      deviceCode: {
        code: "ABCD-1234",
        expiresInMinutes: 15,
        message: "Enter this one-time code in your browser.",
      },
    });
  });

  test("presents QR data only to capable hosts and scrubs it when the owner settles", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    let presentationSettled = false;
    const supported = createQrSession(async (prompter) => {
      await presentQr(prompter, owner);
      presentationSettled = true;
    });

    const prompt = await supported.next();
    expect(prompt.step).toMatchObject({
      type: "qr",
      title: "Link a device",
      qrDataUrl: QR_DATA_URL,
      executor: "client",
    });
    expect(qrImageMocks.renderQrPngDataUrlWithinLimit).toHaveBeenCalledWith(
      QR_TEXT,
      QR_PNG_DATA_URL_MAX_LENGTH,
    );
    if (!prompt.step) {
      throw new Error("expected QR step");
    }
    await expect(supported.answer(prompt.step.id, true)).rejects.toThrow(
      "wizard: QR steps settle through their presentation owner",
    );
    settleOwner();
    await vi.waitFor(() => expect(presentationSettled).toBe(true));
    expect(prompt.step.qrDataUrl).toBeUndefined();
    expect((await supported.next()).status).toBe("done");

    let unsupportedHasQr = true;
    const unsupported = new WizardSession(async (prompter) => {
      unsupportedHasQr = typeof prompter.qrCode === "function";
    });
    expect((await unsupported.next()).status).toBe("done");
    expect(unsupportedHasQr).toBe(false);
  });

  test("rejects invalid PNG output at the QR presentation owner", async () => {
    qrImageMocks.renderQrPngDataUrlWithinLimit.mockResolvedValueOnce(
      "data:image/png;base64,iVBORw0KGgp=",
    );
    const session = createQrSession(async (prompter) => {
      await presentQr(prompter, Promise.resolve());
    });

    await expect(session.next()).resolves.toMatchObject({
      done: true,
      status: "error",
      error: "Error: wizard: QR renderer returned an invalid PNG data URL",
    });
  });

  test("redacts credential text rejected by the QR presentation owner", async () => {
    let rejectOwner!: (error: Error) => void;
    const owner = new Promise<void>((_resolve, reject) => {
      rejectOwner = reject;
    });
    const session = createQrSession(async (prompter) => {
      await presentQr(prompter, owner);
    });

    await expect(session.next()).resolves.toMatchObject({
      done: false,
      step: { type: "qr" },
    });
    const credentialUri = "sgnl://linkdevice?uuid=synthetic-secret&pub_key=synthetic-key";
    rejectOwner(new Error(`signal-cli link failed for ${credentialUri}`));

    const result = await session.next();
    expect(result).toMatchObject({
      done: true,
      status: "error",
      error: "Error: wizard: QR presentation owner failed",
    });
    expect(JSON.stringify(result)).not.toContain(credentialUri);
  });

  test("observes QR owner rejection before awaiting the renderer", async () => {
    let finishRendering!: (value: string) => void;
    const rendering = new Promise<string>((resolve) => {
      finishRendering = resolve;
    });
    qrImageMocks.renderQrPngDataUrlWithinLimit.mockReturnValueOnce(rendering);
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    const ownerCatch = vi.spyOn(owner, "catch");
    const session = createQrSession(async (prompter) => {
      await presentQr(prompter, owner);
    });

    const pending = session.next();
    await vi.waitFor(() =>
      expect(qrImageMocks.renderQrPngDataUrlWithinLimit).toHaveBeenCalledWith(
        QR_TEXT,
        QR_PNG_DATA_URL_MAX_LENGTH,
      ),
    );

    expect(ownerCatch).toHaveBeenCalledOnce();
    finishRendering(QR_DATA_URL);
    await expect(pending).resolves.toMatchObject({ step: { type: "qr" } });
    settleOwner();
    await session.whenSettled();
  });

  test("advances only when the QR owner settles and rejects stale acknowledgements", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    const settled = vi.fn();
    const session = createQrSession(
      async (prompter) => {
        await presentQr(prompter, owner);
        await prompter.text({ message: "Next step" });
      },
      { onQrPresentationOwnerSettled: settled },
    );

    const prompt = await session.next();
    if (!prompt.step) {
      throw new Error("expected QR step");
    }
    settleOwner();
    const next = await session.next();

    expect(prompt.step.qrDataUrl).toBeUndefined();
    expect(settled).toHaveBeenCalledWith(prompt.step.id);
    expect(next.step).toMatchObject({ type: "text", message: "Next step" });
    await expect(session.answer(prompt.step.id, undefined)).rejects.toThrow(
      /wizard: no pending step/,
    );
  });

  test("does not project the subsequent prompt before the QR owner settles", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    const session = createQrSession(async (prompter) => {
      await presentQr(prompter, owner);
      await prompter.text({ message: "Device label" });
    });

    const prompt = await session.next();
    if (!prompt.step) {
      throw new Error("expected QR step");
    }
    expect(session.hasExternalQrPresentationOwner()).toBe(true);
    expect(session.hasOwnedQrPresentation()).toBe(true);

    settleOwner();
    const next = await session.next();
    expect(next.step).toMatchObject({ type: "text", message: "Device label" });
    expect(session.hasExternalQrPresentationOwner()).toBe(false);
    expect(session.hasOwnedQrPresentation()).toBe(false);
    if (!next.step) {
      throw new Error("expected text step");
    }
    await session.answer(next.step.id, "Work laptop");
    await session.whenSettled();
  });

  test("skips a QR step whose owner settled before its first presentation", async () => {
    const session = createQrSession(async (prompter) => {
      await presentQr(prompter, Promise.resolve());
    });

    await expect(session.next()).resolves.toMatchObject({ done: true, status: "done" });
  });

  test("expires QR display bytes without cancelling its external owner", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    const session = createQrSession(async (prompter) => {
      await presentQr(prompter, owner);
      await owner;
    });

    const prompt = await session.next();
    if (!prompt.step) {
      throw new Error("expected QR step");
    }
    expect(session.expireOwnedQrPresentation(prompt.step.id)).toBe(true);
    expect(prompt.step.qrDataUrl).toBeUndefined();
    expect(session.hasExternalQrPresentationOwner()).toBe(true);

    settleOwner();
    await session.whenSettled();
    expect(session.getStatus()).toBe("done");
  });

  test("invalid answers throw", async () => {
    const session = noteRunner();
    const first = await session.next();
    await expect(session.answer("bad-id", null)).rejects.toThrow(/wizard: no pending step/i);
    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);
  });

  test("keeps a validated text step pending after an invalid answer", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({
        message: "Port",
        validate: (value) => (value === "18789" ? undefined : "Enter the expected port"),
      });
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected text step");
    }
    await expect(session.answer(first.step.id, "banana")).resolves.toBe("Enter the expected port");
    expect(session.getStatus()).toBe("running");
    expect((await session.next()).step?.id).toBe(first.step.id);

    await session.answer(first.step.id, "18789");
    expect((await session.next()).status).toBe("done");
  });

  test("rejects non-scalar text answers before validation and resolution", async () => {
    let resolved: string | undefined;
    const session = new WizardSession(async (prompter) => {
      resolved = await prompter.text({
        message: "Token",
        validate: (value) => (value.length > 0 ? undefined : "Token is required"),
      });
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected text step");
    }
    await expect(session.answer(first.step.id, ["token"])).resolves.toBe(
      "wizard: text answer must be a scalar value",
    );
    expect((await session.next()).step?.id).toBe(first.step.id);

    await session.answer(first.step.id, "token");
    expect((await session.next()).status).toBe("done");
    expect(resolved).toBe("token");
  });

  test("cancel marks session and unblocks", async () => {
    const session = new WizardSession(async (_prompter, _signal, owner) => {
      await owner.awaitAnswer(qrStep());
    });

    const step = await session.next();
    expect(step.step?.type).toBe("qr");

    session.cancel();

    expect(step.step?.qrDataUrl).toBeUndefined();
    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("cancelled");
    expect(session.signal.aborted).toBe(true);
  });

  test("refuses cancellation after the durable commit point", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new WizardSession(async () => {
      await gate;
    });

    session.lockCancellation();
    expect(session.cancel()).toBe(false);
    expect(session.getStatus()).toBe("running");
    expect(session.signal.aborted).toBe(false);

    finish();
    expect((await session.next()).status).toBe("done");
  });

  test("expires an abandoned interactive session", async () => {
    vi.useFakeTimers();
    try {
      const session = new WizardSession(
        async (_prompter, _signal, owner) => {
          await owner.awaitAnswer(qrStep());
        },
        { timeoutMs: 1_000 },
      );

      const step = await session.next();
      expect(step.step?.type).toBe("qr");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(step.step?.qrDataUrl).toBeUndefined();
      const done = await session.next();
      expect(done.status).toBe("cancelled");
      expect(session.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a runner finishing after cancellation cannot overwrite cancelled state", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new WizardSession(async () => {
      await gate;
    });

    session.cancel();
    finish();
    await Promise.resolve();

    expect((await session.next()).status).toBe("cancelled");
  });

  test("does not lose terminal completion when the last answer finishes the runner immediately", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "Token" });
    });

    const first = await session.next();
    expect(first.step?.type).toBe("text");
    if (!first.step) {
      throw new Error("expected first step");
    }

    await session.answer(first.step.id, "ok");
    await Promise.resolve();

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("forwards sensitive flag to the emitted text step", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "API key", sensitive: true });
      await prompter.text({ message: "Username" });
    });

    const sensitiveStep = (await session.next()).step;
    expect(sensitiveStep?.type).toBe("text");
    expect(sensitiveStep?.sensitive).toBe(true);
    if (!sensitiveStep) {
      throw new Error("expected sensitive step");
    }
    await session.answer(sensitiveStep.id, "fake-key-aa11");

    const plainStep = (await session.next()).step;
    expect(plainStep?.type).toBe("text");
    expect(plainStep?.sensitive).toBeUndefined();
    if (!plainStep) {
      throw new Error("expected plain step");
    }
    await session.answer(plainStep.id, "alice");
  });

  test("bridges confirm, progress updates, and notes in order", async () => {
    let markInitialUpdateQueued!: () => void;
    const initialUpdateQueued = new Promise<void>((resolve) => {
      markInitialUpdateQueued = resolve;
    });
    let releaseHalfway!: () => void;
    const halfway = new Promise<void>((resolve) => {
      releaseHalfway = resolve;
    });
    let releaseDone!: () => void;
    const done = new Promise<void>((resolve) => {
      releaseDone = resolve;
    });
    const session = new WizardSession(async (prompter) => {
      await prompter.confirm({ message: "Download model?", initialValue: false });
      const progress = prompter.progress("Starting download");
      progress.update("Downloading model... 10%");
      markInitialUpdateQueued();
      await halfway;
      progress.update("Downloading model... 50%");
      await done;
      progress.stop("Model downloaded");
      await prompter.note("Ready to use", "Prepared");
    });

    const confirm = await session.next();
    expect(confirm.step).toMatchObject({
      type: "confirm",
      message: "Download model?",
      initialValue: false,
    });
    if (!confirm.step) {
      throw new Error("expected confirm step");
    }
    await session.answer(confirm.step.id, true);
    await initialUpdateQueued;

    expect(await session.next()).toMatchObject({
      step: {
        type: "progress",
        message: "Starting download",
        executor: "gateway",
      },
    });

    expect(await session.next()).toMatchObject({
      step: { type: "progress", message: "Downloading model... 10%" },
    });

    const halfwayStep = session.next();
    releaseHalfway();
    expect(await halfwayStep).toMatchObject({
      step: { type: "progress", message: "Downloading model... 50%" },
    });

    const doneStep = session.next();
    releaseDone();
    const completedProgress = await doneStep;
    expect(completedProgress).toMatchObject({
      step: { type: "progress", message: "Model downloaded" },
    });
    if (!completedProgress.step) {
      throw new Error("expected completed progress step");
    }
    await expect(session.answer(completedProgress.step.id, undefined)).resolves.toBeUndefined();

    expect(await session.next()).toMatchObject({
      step: { type: "note", title: "Prepared", message: "Ready to use" },
    });
  });
});
