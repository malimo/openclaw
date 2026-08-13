import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import {
  getChannelRuntimeContext,
  registerChannelRuntimeContext,
} from "openclaw/plugin-sdk/channel-runtime-context";
import type { SignalDaemonHandle } from "./daemon.js";
import { getOptionalSignalChannelRuntime } from "./runtime.js";

const SIGNAL_MANAGED_DAEMON_OWNER_CAPABILITY = "managed-daemon-owner";

type SignalManagedDaemonOwner = {
  accountId: string;
  account: string;
  cliPath: string;
  configPath?: string;
  httpHost: string;
  httpPort: number;
};

type SignalManagedDaemonOwnerContext = {
  handle: SignalDaemonHandle;
  owner: SignalManagedDaemonOwner;
};

function sameManagedDaemonOwner(
  left: SignalManagedDaemonOwner,
  right: SignalManagedDaemonOwner,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.account === right.account &&
    left.cliPath === right.cliPath &&
    left.configPath === right.configPath &&
    left.httpHost === right.httpHost &&
    left.httpPort === right.httpPort
  );
}

export function registerSignalManagedDaemonOwner(params: {
  channelRuntime?: ChannelRuntimeSurface;
  handle: SignalDaemonHandle;
  owner: SignalManagedDaemonOwner;
  abortSignal: AbortSignal;
}): void {
  registerChannelRuntimeContext({
    channelRuntime: getOptionalSignalChannelRuntime() ?? params.channelRuntime,
    channelId: "signal",
    accountId: params.owner.accountId,
    capability: SIGNAL_MANAGED_DAEMON_OWNER_CAPABILITY,
    context: {
      handle: params.handle,
      owner: params.owner,
    } satisfies SignalManagedDaemonOwnerContext,
    abortSignal: params.abortSignal,
  });
}

export function isSignalManagedDaemonOwned(owner: SignalManagedDaemonOwner): boolean {
  const context = getChannelRuntimeContext({
    channelRuntime: getOptionalSignalChannelRuntime() ?? undefined,
    channelId: "signal",
    accountId: owner.accountId,
    capability: SIGNAL_MANAGED_DAEMON_OWNER_CAPABILITY,
  }) as SignalManagedDaemonOwnerContext | undefined;
  return Boolean(
    context && !context.handle.isExited() && sameManagedDaemonOwner(context.owner, owner),
  );
}
