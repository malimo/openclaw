import { Worker } from "node:worker_threads";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SessionTranscriptReadScope } from "../session-transcript-readers.js";
import type { SessionTouchedFile } from "./session-touched-files.js";
import type {
  SessionTouchedFilesWorkerRequest,
  SessionTouchedFilesWorkerResult,
} from "./session-touched-files.worker.js";

const REQUEST_TIMEOUT_MS = 120_000;

type PendingRequest = {
  timeout: NodeJS.Timeout;
  resolve: (files: SessionTouchedFile[]) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function workerUrl(): URL {
  return resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "session-touched-files.worker",
    distWorkerPath: "gateway/server-methods/session-touched-files.worker.js",
  });
}

function resolveSourceWorkerExecArgv(): string[] {
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const registerTsx = `import { register } from ${JSON.stringify(tsxApiUrl)}; register();`;
  return ["--import", `data:text/javascript,${encodeURIComponent(registerTsx)}`];
}

function stopWorker(error: Error): void {
  const active = worker;
  worker = undefined;
  active?.removeAllListeners();
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(error);
  }
  pending.clear();
  if (active) {
    void active.terminate();
  }
}

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }
  const resolvedUrl = workerUrl();
  const active = new Worker(
    resolvedUrl,
    resolvedUrl.pathname.endsWith(".ts") ? { execArgv: resolveSourceWorkerExecArgv() } : undefined,
  );
  active.unref();
  active.on("message", (message: SessionTouchedFilesWorkerResult) => {
    const request = pending.get(message.requestId);
    if (!request) {
      return;
    }
    pending.delete(message.requestId);
    clearTimeout(request.timeout);
    if (message.status === "ok") {
      request.resolve(message.files);
    } else {
      request.reject(new Error(message.error));
    }
  });
  active.once("error", (error) => {
    stopWorker(error instanceof Error ? error : new Error(String(error)));
  });
  active.once("exit", (code) => {
    if (worker === active) {
      stopWorker(new Error(`session touched-files worker exited with code ${code}`));
    }
  });
  worker = active;
  return active;
}

export function loadSessionTouchedFilesInWorker(
  scope: SessionTranscriptReadScope,
  cacheKey: string,
): Promise<SessionTouchedFile[]> {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++;
    const active = ensureWorker();
    const timeout = setTimeout(() => {
      if (!pending.has(requestId)) {
        return;
      }
      stopWorker(new Error("session touched-files worker timed out"));
    }, REQUEST_TIMEOUT_MS);
    timeout.unref();
    pending.set(requestId, { timeout, resolve, reject });
    const request: SessionTouchedFilesWorkerRequest = { requestId, scope, cacheKey };
    active.postMessage(request, []);
  });
}

export function closeSessionTouchedFilesWorker(): void {
  if (worker) {
    stopWorker(new Error("session touched-files worker closed"));
  }
}
