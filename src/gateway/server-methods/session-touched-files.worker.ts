import { parentPort, workerData } from "node:worker_threads";
import {
  closeOpenClawAgentDatabases,
  configureOpenClawAgentDatabaseLeaseNamespace,
} from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "../session-transcript-readers.js";
import { loadSessionTouchedFilesInline, type SessionTouchedFile } from "./session-touched-files.js";

export type SessionTouchedFilesWorkerRequest = {
  type: "load";
  requestId: number;
  scope: SessionTranscriptReadScope;
  cacheKey: string;
};

type SessionTouchedFilesWorkerMessage = SessionTouchedFilesWorkerRequest | { type: "shutdown" };

export type SessionTouchedFilesWorkerResult =
  | { type: "result"; requestId: number; status: "ok"; files: SessionTouchedFile[] }
  | { type: "result"; requestId: number; status: "failed"; error: string }
  | { type: "stopped" };

async function handleRequest(
  request: SessionTouchedFilesWorkerRequest,
): Promise<SessionTouchedFilesWorkerResult> {
  try {
    return {
      type: "result",
      requestId: request.requestId,
      status: "ok",
      files: await loadSessionTouchedFilesInline(request.scope, request.cacheKey),
    };
  } catch (error) {
    return {
      type: "result",
      requestId: request.requestId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

if (parentPort) {
  const data: unknown = workerData;
  if (
    !data ||
    typeof data !== "object" ||
    !("leaseNamespace" in data) ||
    typeof data.leaseNamespace !== "string"
  ) {
    throw new Error("session touched-files worker requires a lease namespace");
  }
  configureOpenClawAgentDatabaseLeaseNamespace(data.leaseNamespace);
  const port = parentPort;
  const inFlight = new Set<Promise<void>>();
  let stopping = false;
  port.on("message", (message: SessionTouchedFilesWorkerMessage) => {
    if (message.type === "shutdown") {
      if (stopping) {
        return;
      }
      stopping = true;
      void Promise.allSettled(inFlight).then(() => {
        closeOpenClawAgentDatabases();
        port.postMessage({ type: "stopped" } satisfies SessionTouchedFilesWorkerResult);
        port.close();
      });
      return;
    }
    if (stopping) {
      return;
    }
    const task = handleRequest(message)
      .then((result) => port.postMessage(result))
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  });
}
