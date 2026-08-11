import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQueuedWizardPrompter,
  createRuntimeEnv,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalTransportProbeResult } from "./setup-transport.js";

const mocks = vi.hoisted(() => ({
  probeManagedSignalSetup: vi.fn(
    async (): Promise<SignalTransportProbeResult> => ({ ok: true, status: 200 }),
  ),
}));

vi.mock("./setup-managed-validation.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./setup-managed-validation.js")>();
  return { ...original, probeManagedSignalSetup: mocks.probeManagedSignalSetup };
});

import { signalSetupWizard } from "./setup-surface.js";

function toCredentialValues(
  values: Partial<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function prepareLocal(cfg: OpenClawConfig) {
  const queued = createQueuedWizardPrompter({ selectValues: ["local"] });
  const prepared = await runSetupWizardPrepare({
    prepare: signalSetupWizard.prepare,
    cfg,
    prompter: queued.prompter,
    runtime: createRuntimeEnv({ throwOnExit: false }),
    options: { allowSignalInstall: false },
  });
  return { queued, credentialValues: toCredentialValues(prepared?.credentialValues) };
}

beforeEach(() => {
  mocks.probeManagedSignalSetup.mockReset();
  mocks.probeManagedSignalSetup.mockResolvedValue({ ok: true, status: 200 });
});

describe("Signal managed setup validation wiring", () => {
  it("validates an external-to-managed switch before persisting it", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "external-native", url: "http://signal-helper:8080" },
        },
      },
    };
    const { queued, credentialValues } = await prepareLocal(cfg);

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg,
      credentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.probeManagedSignalSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "+15555550123",
        transport: expect.objectContaining({ kind: "managed-native" }),
      }),
    );
    expect(finalized?.cfg?.channels?.signal?.transport).toEqual(
      expect.objectContaining({ kind: "managed-native" }),
    );
  });

  it("carries existing managed reuse identity when installation is disabled", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            cliPath: "/opt/signal-cli",
            configPath: "/var/lib/signal-cli",
          },
        },
      },
    };
    const { queued, credentialValues } = await prepareLocal(cfg);

    await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg,
      credentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.probeManagedSignalSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        reusableConfiguredAccount: "+15555550123",
        reusableConfiguredTransport: expect.any(String),
      }),
    );
  });

  it("validates an account replacement on a distinct persisted port", async () => {
    const originalCfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
        },
      },
    };
    const { queued, credentialValues } = await prepareLocal(originalCfg);
    const changedCfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550124",
          transport: { kind: "managed-native", httpPort: 8080 },
        },
      },
    };

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: changedCfg,
      credentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.probeManagedSignalSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "+15555550124",
        reusableConfiguredAccount: "+15555550123",
        reusableConfiguredTransport: expect.any(String),
        transport: expect.objectContaining({ httpPort: 8081 }),
      }),
    );
    expect(finalized?.cfg?.channels?.signal?.transport).toEqual(
      expect.objectContaining({ httpPort: 8081 }),
    );
  });

  it("propagates setup cancellation without entering readiness recovery", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
        },
      },
    };
    const { queued, credentialValues } = await prepareLocal(cfg);
    const abort = new AbortController();
    const reason = new DOMException("setup cancelled", "AbortError");
    mocks.probeManagedSignalSetup.mockImplementationOnce(async (params) => {
      expect(params.abortSignal).toBe(abort.signal);
      abort.abort(reason);
      params.abortSignal?.throwIfAborted();
      return { ok: false };
    });

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg,
        credentialValues,
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
        options: { abortSignal: abort.signal },
      }),
    ).rejects.toBe(reason);

    expect(queued.select).toHaveBeenCalledTimes(1);
    expect(queued.note).not.toHaveBeenCalledWith(expect.any(String), "Signal setup");
  });
});
