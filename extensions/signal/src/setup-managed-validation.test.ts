import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginRuntimeMock,
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalDaemonLifecycle } from "./daemon-lifecycle.js";
import type { SignalDaemonHandle } from "./daemon.js";
import { registerSignalManagedDaemonOwner } from "./managed-daemon-runtime-context.js";
import { setSignalRuntime } from "./runtime.js";
import { clearSignalRuntimeForTest } from "./runtime.test-support.js";
import type { SignalTransportProbeResult } from "./setup-transport.js";

const mocks = vi.hoisted(() => ({
  assertBindAvailable: vi.fn(async () => undefined),
  probeTransport: vi.fn(
    async (): Promise<SignalTransportProbeResult> => ({ ok: true, status: 200 }),
  ),
  stop: vi.fn(async () => undefined),
  spawnDaemon: vi.fn(
    (): SignalDaemonHandle => ({
      pid: 1234,
      stop: mocks.stop,
      exited: new Promise<never>(() => {}),
      isExited: () => false,
    }),
  ),
  waitForReady: vi.fn(
    async (params: {
      abortSignal?: AbortSignal;
      check: () => Promise<SignalTransportProbeResult>;
    }) => {
      await params.check();
    },
  ),
}));

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: mocks.waitForReady,
}));
vi.mock("./daemon.js", () => ({ spawnSignalDaemon: mocks.spawnDaemon }));
vi.mock("./setup-daemon-bind.js", () => ({
  assertSignalSetupDaemonBindAvailable: mocks.assertBindAvailable,
}));
vi.mock("./setup-transport.js", async () => {
  const actual =
    await vi.importActual<typeof import("./setup-transport.js")>("./setup-transport.js");
  return { ...actual, probeSignalTransport: mocks.probeTransport };
});

import {
  managedSignalTransportIdentity,
  probeManagedSignalSetup,
} from "./setup-managed-validation.js";

const account = "+15555550123";
const transport = {
  kind: "managed-native" as const,
  cliPath: "/opt/signal-cli",
  configPath: "/var/lib/signal-cli",
  httpHost: "127.0.0.1",
  httpPort: 8080,
};

function createParams(
  cfg: OpenClawConfig = {},
  candidate: typeof transport | (typeof transport & { url: string }) = transport,
  reusableAccount?: string,
) {
  return {
    cfg,
    accountId: "work",
    transport: candidate,
    account,
    ...(reusableAccount
      ? {
          reusableConfiguredAccount: reusableAccount,
          reusableConfiguredTransport: managedSignalTransportIdentity(candidate),
        }
      : {}),
    runtime: createRuntimeEnv({ throwOnExit: false }),
    prompter: createTestWizardPrompter(),
  };
}

beforeEach(() => {
  clearSignalRuntimeForTest();
  setSignalRuntime(createPluginRuntimeMock());
  mocks.assertBindAvailable.mockReset();
  mocks.assertBindAvailable.mockResolvedValue(undefined);
  mocks.probeTransport.mockReset();
  mocks.probeTransport.mockResolvedValue({ ok: true, status: 200 });
  mocks.stop.mockReset();
  mocks.spawnDaemon.mockClear();
  mocks.waitForReady.mockClear();
});

afterEach(() => {
  clearSignalRuntimeForTest();
});

describe("probeManagedSignalSetup", () => {
  it("reuses an exact configured daemon only after selected-account proof", async () => {
    const cfg = {
      channels: { signal: { accounts: { work: { account, transport } } } },
    } as OpenClawConfig;

    await expect(
      probeManagedSignalSetup(createParams(cfg, transport, account)),
    ).resolves.toMatchObject({
      ok: true,
    });

    expect(mocks.probeTransport).toHaveBeenCalledWith(
      expect.objectContaining({ nativeAccountBinding: "selected-account" }),
    );
    expect(mocks.assertBindAvailable).not.toHaveBeenCalled();
    expect(mocks.spawnDaemon).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "localhost connection for an IPv4 loopback bind",
      candidate: { ...transport, url: "http://localhost:8080" },
    },
    {
      name: "IPv4 loopback connection for a localhost bind",
      candidate: { ...transport, httpHost: "localhost", url: "http://127.0.0.1:8080" },
    },
  ])("does not re-probe the managed bind through $name", async ({ candidate }) => {
    const cfg = {
      channels: { signal: { accounts: { work: { account, transport: candidate } } } },
    } as OpenClawConfig;

    await expect(
      probeManagedSignalSetup(createParams(cfg, candidate, account)),
    ).resolves.toMatchObject({ ok: true });

    expect(mocks.probeTransport).toHaveBeenCalledOnce();
    expect(mocks.probeTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          url: `http://${candidate.httpHost}:8080`,
        }),
      }),
    );
  });

  it("uses owner-known proof for the exact daemon registered by the monitor lifecycle", async () => {
    const cfg = {
      channels: { signal: { accounts: { work: { account, transport } } } },
    } as OpenClawConfig;
    const lifecycle = createSignalDaemonLifecycle({});
    const handle = mocks.spawnDaemon();
    mocks.spawnDaemon.mockClear();
    lifecycle.attach(handle);
    registerSignalManagedDaemonOwner({
      handle,
      owner: {
        accountId: "work",
        account,
        cliPath: transport.cliPath,
        configPath: transport.configPath,
        httpHost: transport.httpHost,
        httpPort: transport.httpPort,
      },
      abortSignal: lifecycle.abortSignal,
    });

    try {
      await expect(
        probeManagedSignalSetup(createParams(cfg, transport, account)),
      ).resolves.toMatchObject({ ok: true });
      expect(mocks.probeTransport).toHaveBeenCalledWith(
        expect.objectContaining({ nativeAccountBinding: "owner-known-bound-account" }),
      );
      expect(mocks.assertBindAvailable).not.toHaveBeenCalled();
      expect(mocks.spawnDaemon).not.toHaveBeenCalled();
    } finally {
      await lifecycle.stop();
    }
  });

  it("does not trust an unverifiable listener as the configured account", async () => {
    const cfg = {
      channels: { signal: { accounts: { work: { account, transport } } } },
    } as OpenClawConfig;
    mocks.probeTransport.mockResolvedValueOnce({
      ok: false,
      failureKind: "unverifiable-single-account",
      error: "server account cannot be verified",
    });
    mocks.assertBindAvailable.mockRejectedValueOnce(new Error("address in use (EADDRINUSE)"));

    await expect(
      probeManagedSignalSetup(createParams(cfg, transport, account)),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("EADDRINUSE"),
    });
    expect(mocks.probeTransport).toHaveBeenCalledWith(
      expect.objectContaining({ nativeAccountBinding: "selected-account" }),
    );
    expect(mocks.probeTransport).not.toHaveBeenCalledWith(
      expect.objectContaining({ nativeAccountBinding: "owner-known-bound-account" }),
    );
    expect(mocks.spawnDaemon).not.toHaveBeenCalled();
  });

  it("validates a replacement account on its newly allocated port", async () => {
    const changedAccount = "+15555550124";
    const replacementTransport = { ...transport, httpPort: 8081 };
    const cfg = {
      channels: {
        signal: { accounts: { work: { account: changedAccount, transport } } },
      },
    } as OpenClawConfig;

    await expect(
      probeManagedSignalSetup({
        ...createParams(cfg, replacementTransport, account),
        account: changedAccount,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(mocks.assertBindAvailable).toHaveBeenCalledWith({
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
    expect(mocks.spawnDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ account: changedAccount, httpPort: 8081 }),
    );
  });

  it("spawns the selected account on the final port and always stops it", async () => {
    await expect(probeManagedSignalSetup(createParams())).resolves.toMatchObject({ ok: true });

    expect(mocks.spawnDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ account, httpPort: 8080, receiveMode: "manual" }),
    );
    expect(mocks.probeTransport).toHaveBeenCalledWith(
      expect.objectContaining({ nativeAccountBinding: "owner-known-bound-account" }),
    );
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("passes setup cancellation to readiness and rethrows its reason after cleanup", async () => {
    const abort = new AbortController();
    const reason = new DOMException("setup cancelled", "AbortError");
    mocks.waitForReady.mockImplementationOnce(async ({ abortSignal }) => {
      expect(abortSignal).toBe(abort.signal);
      abort.abort(reason);
    });

    await expect(
      probeManagedSignalSetup({ ...createParams(), abortSignal: abort.signal }),
    ).rejects.toBe(reason);

    expect(mocks.spawnDaemon).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("returns the actual final-port bind category without spawning", async () => {
    mocks.assertBindAvailable.mockRejectedValueOnce(
      new Error("address unavailable (EADDRNOTAVAIL)"),
    );

    await expect(probeManagedSignalSetup(createParams())).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("EADDRNOTAVAIL"),
    });
    expect(mocks.spawnDaemon).not.toHaveBeenCalled();
  });

  it("probes a separate connection URL with selected-account verification", async () => {
    const candidate = { ...transport, url: "https://signal.example:9443" };
    await probeManagedSignalSetup(
      createParams(
        {
          channels: {
            signal: {
              accounts: {
                work: { account, transport: candidate },
              },
            },
          },
        },
        candidate,
      ),
    );

    expect(mocks.probeTransport).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ nativeAccountBinding: "owner-known-bound-account" }),
    );
  });
});
