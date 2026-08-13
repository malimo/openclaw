import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  SystemAgentChatEngine,
  type SystemAgentChatEngineOptions,
} from "../../system-agent/chat-engine.js";

export async function makeDelayedTerminalQrEngine(
  options: Pick<SystemAgentChatEngineOptions, "deps" | "verifiedInference">,
) {
  const ownerSettled = createDeferred();
  const runnerFinished = createDeferred();
  const auditStarted = createDeferred();
  const releaseAudit = createDeferred();
  const auditFinished = createDeferred();
  const engine = new SystemAgentChatEngine(
    {
      ...options,
      runAgentTurn: async () => ({ text: "Everything is healthy." }),
      planWithAssistant: async () => null,
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
  const prompt = await engine.handle("connect telegram");
  return {
    engine,
    stepId: expectDefined(prompt.step?.id, "QR step id"),
    settleOwner: async () => {
      ownerSettled.resolve();
      await runnerFinished.promise;
    },
    auditStarted: auditStarted.promise,
    releaseTerminal: async () => {
      releaseAudit.resolve();
      await auditFinished.promise;
      await engine.resolveOperatorApproval(null, "queue-drain");
    },
  };
}
