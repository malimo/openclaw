import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  fakeOverviewLoader,
  SystemAgentChatEngine,
  expectDefined,
} from "./chat-engine.test-support.js";
import { ChatWizardHost, type ChatWizardHostDependencies } from "./chat-wizard-host.js";

const QR_TEXT = "https://example.test/pair";

function createQrEngine(
  runChannelSetupWizard: NonNullable<ChatWizardHostDependencies["runChannelSetupWizard"]>,
  appendAuditEntry?: ChatWizardHostDependencies["appendAuditEntry"],
) {
  return new SystemAgentChatEngine({
    runAgentTurn: async () => null,
    planWithAssistant: async () => null,
    deps: { loadOverview: fakeOverviewLoader() },
    supportsQrCode: true,
    runChannelSetupWizard,
    ...(appendAuditEntry ? { appendAuditEntry } : {}),
  });
}

describe("SystemAgentChatEngine passive QR polling", () => {
  it("single-flights repeated observations of one passive QR step", async () => {
    const owner = createDeferred();
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: owner.promise,
      });
    });
    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step, "QR step").id;
    const observationStarted = createDeferred();
    const releaseObservation = createDeferred();
    const poll = vi.spyOn(ChatWizardHost.prototype, "pollStep").mockImplementation(async () => {
      observationStarted.resolve();
      await releaseObservation.promise;
      return { text: "Observed", configWritten: false };
    });

    try {
      const first = engine.pollStep(stepId);
      await observationStarted.promise;
      const retries = Array.from({ length: 32 }, () => engine.pollStep(stepId));
      await expect(first).resolves.toMatchObject({ wizardSettling: true });
      await expect(Promise.all(retries)).resolves.toEqual(
        Array.from({ length: 32 }, () => expect.objectContaining({ wizardSettling: true })),
      );

      releaseObservation.resolve();
      await engine.resolveOperatorApproval(null, "queue-drain");
      expect(poll).toHaveBeenCalledOnce();
    } finally {
      poll.mockRestore();
      owner.resolve();
      await engine.dispose();
      expect(engine.hasPendingQrCode()).toBe(false);
    }
  });

  it("replays a dropped follow-up until the wizard advances", async () => {
    const owner = createDeferred();
    const releaseFollowUp = createDeferred();
    const followUpPresented = createDeferred();
    const secondStepPresented = createDeferred();
    const engine = createQrEngine(async (_channel, prompter) => {
      await prompter.qrCode?.({
        title: "Link a device",
        message: "Scan this QR code and approve the device.",
        text: QR_TEXT,
        dismissed: owner.promise,
      });
      await releaseFollowUp.promise;
      const label = prompter.text({
        message: "Device label",
        validate: (value) => (value === "OpenClaw" ? undefined : "Choose OpenClaw"),
      });
      followUpPresented.resolve();
      await label;
      const location = prompter.text({ message: "Device location" });
      secondStepPresented.resolve();
      await location;
    });

    try {
      const prompt = await engine.handle("connect telegram");
      const qrStepId = expectDefined(prompt.step, "QR step").id;
      owner.resolve();
      await expect(engine.pollStep(qrStepId)).resolves.toMatchObject({ wizardSettling: true });
      releaseFollowUp.resolve();
      await followUpPresented.promise;

      let followUp: Awaited<ReturnType<SystemAgentChatEngine["pollStep"]>> | undefined;
      await vi.waitFor(async () => {
        followUp = await engine.pollStep(qrStepId);
        expect(followUp.step?.type).toBe("text");
      });
      const droppedReply = expectDefined(followUp, "follow-up reply");
      const followUpStep = expectDefined(droppedReply.step, "follow-up step");
      await expect(engine.pollStep(qrStepId)).resolves.toEqual(droppedReply);
      expect(engine.hasPendingQrCode()).toBe(false);

      const invalid = await engine.answerWizard({ stepId: followUpStep.id, value: "Other" });
      expect(invalid.step?.id).toBe(followUpStep.id);
      await expect(engine.pollStep(qrStepId)).resolves.toMatchObject({
        step: { id: followUpStep.id, type: "text" },
      });

      const advance = engine.answerWizard({ stepId: followUpStep.id, value: "OpenClaw" });
      const stalePoll = engine.pollStep(qrStepId);
      await advance;
      await secondStepPresented.promise;
      await expect(stalePoll).rejects.toThrow("stale step");
    } finally {
      await engine.dispose();
    }
  });

  it("records one terminal history entry for concurrent poll subscribers", async () => {
    const owner = createDeferred();
    const runnerFinished = createDeferred();
    const auditStarted = createDeferred();
    const releaseAudit = createDeferred();
    let auditInFlight = false;
    const engine = createQrEngine(
      async (_channel, prompter) => {
        await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code and approve the device.",
          text: QR_TEXT,
          dismissed: owner.promise,
        });
        runnerFinished.resolve();
      },
      async () => {
        auditInFlight = true;
        auditStarted.resolve();
        await releaseAudit.promise;
        return "";
      },
    );

    const prompt = await engine.handle("connect telegram");
    const stepId = expectDefined(prompt.step, "QR step").id;
    owner.resolve();
    await runnerFinished.promise;
    await vi.waitFor(async () => {
      const reply = await engine.pollStep(stepId);
      expect(auditInFlight).toBe(true);
      expect(reply).toMatchObject({ wizardSettling: true });
    });
    await auditStarted.promise;
    const subscribers = Array.from({ length: 16 }, () => engine.pollStep(stepId));
    await expect(Promise.all(subscribers)).resolves.toEqual(
      Array.from({ length: 16 }, () => expect.objectContaining({ wizardSettling: true })),
    );
    releaseAudit.resolve();

    let terminal: Awaited<ReturnType<SystemAgentChatEngine["pollStep"]>> | undefined;
    await vi.waitFor(async () => {
      terminal = await engine.pollStep(stepId);
      expect(terminal.wizardSettling).not.toBe(true);
    });
    const completed = expectDefined(terminal, "terminal reply");
    expect(
      engine
        .historySince(0)
        .filter((turn) => turn.role === "assistant" && turn.text === completed.text),
    ).toHaveLength(1);
    await engine.dispose();
  });
});
