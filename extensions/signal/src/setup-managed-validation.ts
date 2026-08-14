import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { resolveSignalAccount, resolveSignalTransport } from "./accounts.js";
import { spawnSignalDaemon } from "./daemon.js";
import { isSignalManagedDaemonOwned } from "./managed-daemon-runtime-context.js";
import { assertSignalSetupDaemonBindAvailable } from "./setup-daemon-bind.js";
import {
  probeSignalTransport,
  type SignalManagedNativeTransport,
  type SignalTransportProbeResult,
} from "./setup-transport.js";
import { isSignalManagedNativeConnectionUrlForBind } from "./transport-policy.js";
import { buildSignalTransportHttpUrl, normalizeSignalTransportUrl } from "./transport-url.js";

type ResolvedManagedSignalTransport = Extract<
  ReturnType<typeof resolveSignalTransport>,
  { kind: "managed-native" }
>;

function sameManagedTransport(
  left: ResolvedManagedSignalTransport,
  right: ResolvedManagedSignalTransport,
): boolean {
  return (
    left.cliPath === right.cliPath &&
    left.configPath === right.configPath &&
    left.httpHost === right.httpHost &&
    left.httpPort === right.httpPort &&
    left.baseUrl === right.baseUrl &&
    left.startupTimeoutMs === right.startupTimeoutMs &&
    left.receiveMode === right.receiveMode &&
    left.ignoreStories === right.ignoreStories
  );
}

function hasExactAppliedGatewayConfig(params: {
  payload: unknown;
  accountId: string;
  account: string;
  resolved: ResolvedManagedSignalTransport;
}): boolean {
  if (
    !isRecord(params.payload) ||
    typeof params.payload.configRevisionHash !== "string" ||
    params.payload.configRevisionHash !== params.payload.appliedConfigHash ||
    !isRecord(params.payload.sourceConfig)
  ) {
    return false;
  }
  const gatewayAccount = resolveSignalAccount({
    cfg: params.payload.sourceConfig as OpenClawConfig,
    accountId: params.accountId,
  });
  return (
    normalizeOptionalString(gatewayAccount.config.account) === params.account &&
    gatewayAccount.transport.kind === "managed-native" &&
    sameManagedTransport(gatewayAccount.transport, params.resolved)
  );
}

function hasReadyGatewaySignalRuntime(params: {
  payload: unknown;
  accountId: string;
  account: string;
  baseUrl: string;
}): boolean {
  if (!isRecord(params.payload) || !isRecord(params.payload.channelAccounts)) {
    return false;
  }
  const accounts = params.payload.channelAccounts.signal;
  if (!Array.isArray(accounts)) {
    return false;
  }
  const expectedBaseUrl = normalizeSignalTransportUrl(params.baseUrl);
  return accounts.some(
    (entry) =>
      isRecord(entry) &&
      entry.accountId === params.accountId &&
      entry.identity === params.account &&
      entry.running === true &&
      entry.connected === true &&
      typeof entry.baseUrl === "string" &&
      normalizeSignalTransportUrl(entry.baseUrl) === expectedBaseUrl,
  );
}

async function isManagedSignalDaemonOwnedByGateway(params: {
  cfg: OpenClawConfig;
  accountId: string;
  account: string;
  resolved: ResolvedManagedSignalTransport;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  if (params.cfg.gateway?.mode === "remote") {
    return false;
  }
  try {
    const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
    const requestOptions = {
      expectFinal: false,
      progress: false,
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
    };
    const appliedConfig = await callGatewayFromCli(
      "config.get",
      { timeout: "5000", json: true },
      {},
      requestOptions,
    );
    if (!hasExactAppliedGatewayConfig({ ...params, payload: appliedConfig })) {
      return false;
    }
    const status = await callGatewayFromCli(
      "channels.status",
      { timeout: "5000", json: true },
      { channel: "signal" },
      requestOptions,
    );
    return hasReadyGatewaySignalRuntime({
      payload: status,
      accountId: params.accountId,
      account: params.account,
      baseUrl: params.resolved.baseUrl,
    });
  } catch {
    params.abortSignal?.throwIfAborted();
    return false;
  }
}

export function managedSignalTransportIdentity(transport: SignalManagedNativeTransport): string {
  const resolved = resolveSignalTransport(transport);
  if (resolved.kind !== "managed-native") {
    throw new Error("Signal setup did not resolve a managed signal-cli transport.");
  }
  return JSON.stringify({
    cliPath: resolved.cliPath,
    configPath: resolved.configPath,
    httpHost: resolved.httpHost,
    httpPort: resolved.httpPort,
    baseUrl: resolved.baseUrl,
    startupTimeoutMs: resolved.startupTimeoutMs,
    receiveMode: resolved.receiveMode,
    ignoreStories: resolved.ignoreStories,
  });
}

async function probeManagedBind(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalManagedNativeTransport;
  resolved: ResolvedManagedSignalTransport;
  account: string;
  accountBinding: "selected-account" | "owner-known-bound-account";
  abortSignal?: AbortSignal;
}): Promise<SignalTransportProbeResult> {
  params.abortSignal?.throwIfAborted();
  const result = await probeSignalTransport({
    cfg: params.cfg,
    accountId: params.accountId,
    transport: {
      ...params.transport,
      httpHost: params.resolved.httpHost,
      httpPort: params.resolved.httpPort,
      url: buildSignalTransportHttpUrl(params.resolved.httpHost, params.resolved.httpPort),
    },
    account: params.account,
    nativeAccountBinding: params.accountBinding,
    timeoutMs: 1_000,
  }).catch((error: unknown) => ({ ok: false, error: String(error) }));
  params.abortSignal?.throwIfAborted();
  return result;
}

function hasSeparateConnectionUrl(params: {
  transport: SignalManagedNativeTransport;
  resolved: ResolvedManagedSignalTransport;
}): boolean {
  return !isSignalManagedNativeConnectionUrlForBind({
    ...params.transport,
    url: params.resolved.baseUrl,
    httpHost: params.resolved.httpHost,
    httpPort: params.resolved.httpPort,
  });
}

async function probeSeparateConnectionUrl(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalManagedNativeTransport;
  resolved: ResolvedManagedSignalTransport;
  account: string;
  abortSignal?: AbortSignal;
}): Promise<SignalTransportProbeResult> {
  params.abortSignal?.throwIfAborted();
  if (!hasSeparateConnectionUrl(params)) {
    return { ok: true, status: 200, error: null };
  }
  const result = await probeSignalTransport({
    cfg: params.cfg,
    accountId: params.accountId,
    transport: params.transport,
    account: params.account,
    timeoutMs: 1_000,
  }).catch((error: unknown) => ({ ok: false, error: String(error) }));
  params.abortSignal?.throwIfAborted();
  return result;
}

export async function probeManagedSignalSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalManagedNativeTransport;
  account: string;
  reusableConfiguredAccount?: string;
  reusableConfiguredTransport?: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  abortSignal?: AbortSignal;
}): Promise<SignalTransportProbeResult> {
  params.abortSignal?.throwIfAborted();
  const resolved = resolveSignalTransport(params.transport);
  if (resolved.kind !== "managed-native") {
    throw new Error("Signal setup did not resolve a managed signal-cli transport.");
  }
  const progress = params.prompter.progress("Validating Signal setup...");
  let daemon: ReturnType<typeof spawnSignalDaemon> | undefined;
  let unverifiableConfiguredDaemon = false;
  let result: SignalTransportProbeResult = { ok: false, error: "Signal transport probe failed." };
  try {
    const configuredAccountInfo = resolveSignalAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
    const configured = configuredAccountInfo.transport;
    const configuredAccount = normalizeOptionalString(configuredAccountInfo.config.account);
    if (
      configured.kind === "managed-native" &&
      configuredAccount === params.account &&
      params.reusableConfiguredAccount === params.account &&
      params.reusableConfiguredTransport === managedSignalTransportIdentity(configured)
    ) {
      if (sameManagedTransport(configured, resolved)) {
        let ownerKnown = isSignalManagedDaemonOwned({
          accountId: configuredAccountInfo.accountId,
          account: params.account,
          cliPath: resolved.cliPath,
          ...(resolved.configPath ? { configPath: resolved.configPath } : {}),
          httpHost: resolved.httpHost,
          httpPort: resolved.httpPort,
        });
        result = await probeManagedBind({
          ...params,
          resolved,
          accountBinding: ownerKnown ? "owner-known-bound-account" : "selected-account",
        });
        if (result.ok) {
          result = await probeSeparateConnectionUrl({ ...params, resolved });
          return result;
        }
        if (
          !ownerKnown &&
          result.failureKind === "unverifiable-single-account" &&
          (await isManagedSignalDaemonOwnedByGateway({
            cfg: params.cfg,
            accountId: configuredAccountInfo.accountId,
            account: params.account,
            resolved,
            ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          }))
        ) {
          // The Gateway is the cross-process lifecycle owner. Its applied config plus ready
          // runtime replaces the in-process handle proof without trusting an arbitrary SSE peer.
          ownerKnown = true;
          result = await probeManagedBind({
            ...params,
            resolved,
            accountBinding: "owner-known-bound-account",
          });
          if (result.ok) {
            return await probeSeparateConnectionUrl({ ...params, resolved });
          }
        }
        if (ownerKnown) {
          return result;
        }
        unverifiableConfiguredDaemon = result.failureKind === "unverifiable-single-account";
      }
    }

    try {
      await assertSignalSetupDaemonBindAvailable({
        httpHost: resolved.httpHost,
        httpPort: resolved.httpPort,
      });
    } catch (error) {
      if (!unverifiableConfiguredDaemon) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `OpenClaw could not confirm ownership of the running Signal daemon. Run \`openclaw gateway stop\`, retry setup, then restart the Gateway. ${detail}`,
        { cause: error },
      );
    }
    if (hasSeparateConnectionUrl({ ...params, resolved })) {
      const preexistingConnection = await probeSeparateConnectionUrl({ ...params, resolved });
      if (preexistingConnection.ok) {
        return {
          ok: false,
          error:
            "Signal managed connection URL was already serving the selected account before OpenClaw started its daemon. Use external-native for an independently operated Signal server.",
        };
      }
    }
    params.abortSignal?.throwIfAborted();
    const spawnedDaemon = spawnSignalDaemon({
      cliPath: resolved.cliPath,
      ...(resolved.configPath ? { configPath: resolved.configPath } : {}),
      account: params.account,
      httpHost: resolved.httpHost,
      httpPort: resolved.httpPort,
      // Setup proof must not drain messages before the real monitor owns delivery.
      receiveMode: "manual",
      ...(typeof resolved.ignoreStories === "boolean"
        ? { ignoreStories: resolved.ignoreStories }
        : {}),
    });
    daemon = spawnedDaemon;
    await waitForTransportReady({
      label: "signal-cli setup daemon",
      timeoutMs: Math.min(120_000, Math.max(1_000, resolved.startupTimeoutMs)),
      logAfterMs: 10_000,
      logIntervalMs: 10_000,
      pollIntervalMs: 150,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      runtime: params.runtime,
      check: async () => {
        if (spawnedDaemon.isExited()) {
          throw new Error("signal-cli exited before its HTTP server became ready.");
        }
        result = await probeManagedBind({
          ...params,
          resolved,
          accountBinding: "owner-known-bound-account",
        });
        return result;
      },
    });
    params.abortSignal?.throwIfAborted();
    if (result.ok) {
      result = await probeSeparateConnectionUrl({ ...params, resolved });
    }
    return result;
  } catch (error) {
    params.abortSignal?.throwIfAborted();
    result = { ok: false, error: String(error) };
    return result;
  } finally {
    try {
      await daemon?.stop();
    } finally {
      progress.stop(
        params.abortSignal?.aborted
          ? "Signal setup validation cancelled."
          : result.ok
            ? "Signal setup validated."
            : "Signal setup validation failed.",
      );
    }
  }
}
