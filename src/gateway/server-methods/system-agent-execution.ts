import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";

const SYSTEM_AGENT_GATEWAY_EXECUTION_KEY = "gateway";
const systemAgentGatewayExecutionQueue = new KeyedAsyncQueue();

export async function runSystemAgentGatewayTask<T>(task: () => Promise<T>): Promise<T> {
  // Track every accepted RPC as active, never queued: restart draining snapshots
  // active ids, so a queued OpenClaw request could otherwise outlive its socket.
  setCommandLaneConcurrency(CommandLane.SystemAgent, Number.MAX_SAFE_INTEGER);
  return await enqueueCommandInLane(CommandLane.SystemAgent, () =>
    // Bound expensive detection, activation, and agent turns without hiding
    // accepted work from restart draining. This also makes session eviction and
    // setup writes atomic with respect to other OpenClaw gateway requests.
    systemAgentGatewayExecutionQueue.enqueue(SYSTEM_AGENT_GATEWAY_EXECUTION_KEY, task),
  );
}
