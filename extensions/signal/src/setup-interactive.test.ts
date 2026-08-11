import { hostname } from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQueuedWizardPrompter,
  createRuntimeEnv,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { WizardCancelledError } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalTransportProbeResult } from "./setup-transport.js";

const mocks = vi.hoisted(() => ({
  hostname: vi.fn(() => "signal-host"),
  networkInterfaces: vi.fn(() => ({})),
  detectSignalTransport: vi.fn(
    async (params: {
      url: string;
    }): Promise<{ kind: "external-native" | "container"; url: string }> => ({
      kind: "external-native",
      url: params.url,
    }),
  ),
  probeSignalTransport: vi.fn(
    async (): Promise<SignalTransportProbeResult> => ({ ok: true, status: 200 }),
  ),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    hostname: mocks.hostname,
    networkInterfaces: mocks.networkInterfaces,
  };
});

vi.mock("./setup-transport.js", async () => {
  const actual =
    await vi.importActual<typeof import("./setup-transport.js")>("./setup-transport.js");
  return {
    ...actual,
    detectSignalTransport: mocks.detectSignalTransport,
    probeSignalTransport: mocks.probeSignalTransport,
  };
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

describe("Signal existing-server setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostname.mockReturnValue("signal-host");
    mocks.networkInterfaces.mockReturnValue({});
    mocks.detectSignalTransport.mockImplementation(async ({ url }: { url: string }) => ({
      kind: "external-native",
      url,
    }));
    mocks.probeSignalTransport.mockResolvedValue({ ok: true, status: 200 });
  });

  it("defaults a configured external account to its current server", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server"],
      textValues: ["http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: { kind: "external-native", url: "http://signal-helper:8080" },
          },
        },
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "existing-server" }),
    );
    expect(queued.text).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "http://signal-helper:8080" }),
    );
    expect(prepared?.credentialValues).toEqual({
      signalTransportKind: "external-native",
      signalServerUrl: "http://signal-helper:8080",
      signalExternalReuseAccount: "+15555550123",
      signalExternalReuseTransport: expect.any(String),
    });
  });

  it("preserves an unchanged configured single-account endpoint only after confirmation", async () => {
    mocks.probeSignalTransport.mockResolvedValue({
      ok: false,
      status: 200,
      failureKind: "unverifiable-single-account",
      error: "server account cannot be verified",
    });
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "external-native", url: "http://signal-helper:8080" },
        },
      },
    };
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server"],
      textValues: ["http://signal-helper:8080"],
      confirmValues: [true],
    });
    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg,
      credentialValues: toCredentialValues(prepared?.credentialValues),
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("cannot verify"),
        initialValue: false,
      }),
    );
    expect(finalized?.cfg?.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://signal-helper:8080",
    });
    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("without server-side account verification"),
      "Signal server ready",
    );
  });

  it("keeps a changed endpoint on strict account verification", async () => {
    mocks.probeSignalTransport.mockResolvedValue({
      ok: false,
      failureKind: "unverifiable-single-account",
      error: "server account cannot be verified",
    });
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "external-native", url: "http://old-signal:8080" },
        },
      },
    };
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "stop"],
      textValues: ["http://new-signal:8080"],
    });
    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg,
        credentialValues: toCredentialValues(prepared?.credentialValues),
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(queued.confirm).not.toHaveBeenCalled();
    expect(cfg.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://old-signal:8080",
    });
  });

  it("keeps a changed account on strict account verification", async () => {
    mocks.probeSignalTransport.mockResolvedValue({
      ok: false,
      failureKind: "unverifiable-single-account",
      error: "server account cannot be verified",
    });
    const originalCfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "external-native", url: "http://signal-helper:8080" },
        },
      },
    };
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "stop"],
      textValues: ["http://signal-helper:8080"],
    });
    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: originalCfg,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });
    const changedCfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550124",
          transport: { kind: "external-native", url: "http://signal-helper:8080" },
        },
      },
    };

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: changedCfg,
        credentialValues: toCredentialValues(prepared?.credentialValues),
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(queued.confirm).not.toHaveBeenCalled();
  });

  it("detects, validates, and persists a container for the selected account", async () => {
    mocks.detectSignalTransport.mockResolvedValue({
      kind: "container",
      url: "http://signal-helper:8080",
    });
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server"],
      textValues: ["http://signal-helper:8080"],
    });
    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {},
      accountId: "work",
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });
    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {
        channels: { signal: { accounts: { work: { account: "+15555550123" } } } },
      } as OpenClawConfig,
      accountId: "work",
      credentialValues: toCredentialValues(prepared?.credentialValues),
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.probeSignalTransport).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "work",
      transport: { kind: "container", url: "http://signal-helper:8080" },
      account: "+15555550123",
    });
    expect(finalized?.cfg?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal-helper:8080",
    });
    expect(queued.note).toHaveBeenCalledWith(
      "Validated +15555550123 on http://signal-helper:8080.",
      "Signal server ready",
    );
  });

  it("requires the selected account before native readiness is probed", async () => {
    const queued = createQueuedWizardPrompter({ textValues: ["+15555550123"] });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      credentialValues: {
        signalTransportKind: "external-native",
        signalServerUrl: "http://signal-helper:8080",
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Signal phone number" }),
    );
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith(
      expect.objectContaining({ account: "+15555550123" }),
    );
    expect(finalized?.cfg?.channels?.signal?.account).toBe("+15555550123");
  });

  it("rejects an existing-server recovery account owned by a sibling", async () => {
    mocks.probeSignalTransport.mockResolvedValueOnce({
      ok: false,
      error: "selected account is unavailable",
    });
    const queued = createQueuedWizardPrompter({
      selectValues: ["account"],
      textValues: ["+15555550124"],
    });
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          defaultAccount: "personal",
          accounts: {
            personal: { account: "+15555550124" },
            work: { account: "+15555550123" },
          },
        },
      },
    };

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg,
        accountId: "work",
        credentialValues: {
          signalTransportKind: "external-native",
          signalServerUrl: "http://signal-helper:8080",
        },
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toThrow(
      "+15555550124 is already assigned to another OpenClaw Signal account. Choose a different account or remove the existing assignment, then retry setup.",
    );

    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(cfg.channels?.signal?.accounts?.work?.account).toBe("+15555550123");
  });

  it("does not persist an unverified server", async () => {
    mocks.probeSignalTransport.mockResolvedValue({
      ok: false,
      failureKind: "unverifiable-single-account",
      error: "not ready",
    });
    const cfg: OpenClawConfig = {
      channels: { signal: { account: "+15555550123" } },
    };
    const queued = createQueuedWizardPrompter({ selectValues: ["stop"] });

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg,
        credentialValues: {
          signalTransportKind: "external-native",
          signalServerUrl: "http://signal-helper:8080",
        },
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(cfg.channels?.signal?.transport).toBeUndefined();
    expect(queued.confirm).not.toHaveBeenCalled();
    expect(queued.note).toHaveBeenCalledWith(expect.stringContaining("not ready"), "Signal setup");
  });

  it("rejects an alias of a managed daemon and accepts an independent server", async () => {
    mocks.networkInterfaces.mockImplementationOnce(() => {
      throw new Error("interface enumeration denied");
    });
    const machineEndpoint = `http://${hostname()}:8080`;
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "url"],
      textValues: [machineEndpoint, "http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              httpHost: "0.0.0.0",
              httpPort: 8080,
            },
          },
        },
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.detectSignalTransport).toHaveBeenCalledTimes(2);
    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw-managed Signal daemon"),
      "Signal server URL",
    );
    expect(prepared?.credentialValues).toEqual({
      signalTransportKind: "external-native",
      signalServerUrl: "http://signal-helper:8080",
    });
  });
});
