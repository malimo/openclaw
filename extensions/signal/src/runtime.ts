// Signal plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "signal",
  errorMessage: "Signal runtime not initialized",
});
const channelRuntimeStore = createPluginRuntimeStore<PluginRuntime["channel"]>({
  key: "plugin-runtime:signal:channel-context-owner",
  errorMessage: "Signal channel runtime not initialized",
});

function setSignalRuntime(next: PluginRuntime): void {
  // Live monitor leases belong to the process-lifetime channel registry, even if plugin
  // discovery refreshes the surrounding runtime object while an account task is active.
  if (!channelRuntimeStore.tryGetRuntime()) {
    channelRuntimeStore.setRuntime(next.channel);
  }
  runtimeStore.setRuntime(next);
}

const getOptionalSignalRuntime = runtimeStore.tryGetRuntime;
const getOptionalSignalChannelRuntime = channelRuntimeStore.tryGetRuntime;

export { getOptionalSignalChannelRuntime, getOptionalSignalRuntime, setSignalRuntime };
