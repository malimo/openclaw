import { parentPort } from "node:worker_threads";
import type { SessionTranscriptReadScope } from "../session-transcript-readers.js";
import { loadSessionTouchedFilesInline, type SessionTouchedFile } from "./session-touched-files.js";

export type SessionTouchedFilesWorkerRequest = {
  requestId: number;
  scope: SessionTranscriptReadScope;
  cacheKey: string;
};

export type SessionTouchedFilesWorkerResult =
  | { requestId: number; status: "ok"; files: SessionTouchedFile[] }
  | { requestId: number; status: "failed"; error: string };

async function handleRequest(
  request: SessionTouchedFilesWorkerRequest,
): Promise<SessionTouchedFilesWorkerResult> {
  try {
    return {
      requestId: request.requestId,
      status: "ok",
      files: await loadSessionTouchedFilesInline(request.scope, request.cacheKey),
    };
  } catch (error) {
    return {
      requestId: request.requestId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (request: SessionTouchedFilesWorkerRequest) => {
    void handleRequest(request).then((result) => port.postMessage(result));
  });
}
