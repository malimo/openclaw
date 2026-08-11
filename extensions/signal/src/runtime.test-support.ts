// Signal test support owns cleanup for process-global plugin runtime state.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { clearRuntime: clearSignalRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "signal",
  errorMessage: "Signal runtime not initialized",
});
const { clearRuntime: clearSignalChannelRuntime } = createPluginRuntimeStore<
  PluginRuntime["channel"]
>({
  key: "plugin-runtime:signal:channel-context-owner",
  errorMessage: "Signal channel runtime not initialized",
});

export function clearSignalRuntimeForTest(): void {
  clearSignalRuntime();
  clearSignalChannelRuntime();
}
