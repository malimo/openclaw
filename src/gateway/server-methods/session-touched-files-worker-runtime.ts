import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { releaseOpenClawAgentDatabaseLeasesByNamespace } from "../../state/openclaw-agent-db-lease.js";
import type { SessionTranscriptReadScope } from "../session-transcript-readers.js";
import type { SessionTouchedFile } from "./session-touched-files.js";
import type {
  SessionTouchedFilesWorkerRequest,
  SessionTouchedFilesWorkerResult,
} from "./session-touched-files.worker.js";

const REQUEST_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

type PendingRequest = {
  timeout: NodeJS.Timeout;
  resolve: (files: SessionTouchedFile[]) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let workerLeaseNamespace: string | undefined;
const workerLeaseEnvironments = new Map<string, NodeJS.ProcessEnv | undefined>();
let closing: Promise<void> | undefined;
let stopping: Promise<Error | undefined> | undefined;
let acceptingRequests = true;
let gatewayOwners = 0;
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

async function stopWorkerNow(error: Error): Promise<Error | undefined> {
  const active = worker;
  const leaseNamespace = workerLeaseNamespace;
  const leaseEnvironments = [...workerLeaseEnvironments.values()];
  worker = undefined;
  workerLeaseNamespace = undefined;
  workerLeaseEnvironments.clear();
  active?.removeAllListeners();
  const stoppedRequests = [...pending.values()];
  for (const request of stoppedRequests) {
    clearTimeout(request.timeout);
  }
  pending.clear();
  if (active) {
    await active.terminate();
  }
  let cleanupError: Error | undefined;
  if (leaseNamespace) {
    try {
      for (const env of leaseEnvironments) {
        releaseOpenClawAgentDatabaseLeasesByNamespace(leaseNamespace, { env });
      }
    } catch (cause) {
      cleanupError = new Error("failed to release terminated session worker database leases", {
        cause,
      });
    }
  }
  for (const request of stoppedRequests) {
    request.reject(cleanupError ?? error);
  }
  return cleanupError;
}

function stopWorker(error: Error): Promise<Error | undefined> {
  if (stopping) {
    return stopping;
  }
  const activeStop = stopWorkerNow(error);
  stopping = activeStop;
  const clearStopping = () => {
    if (stopping === activeStop) {
      stopping = undefined;
    }
  };
  void activeStop.then(clearStopping, clearStopping);
  return activeStop;
}

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }
  const resolvedUrl = workerUrl();
  const leaseNamespace = crypto.randomUUID();
  const active = new Worker(resolvedUrl, {
    ...(resolvedUrl.pathname.endsWith(".ts") ? { execArgv: resolveSourceWorkerExecArgv() } : {}),
    workerData: { leaseNamespace },
  });
  active.unref();
  active.on("message", (message: SessionTouchedFilesWorkerResult) => {
    if (message.type === "stopped") {
      return;
    }
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
    void stopWorker(error instanceof Error ? error : new Error(String(error))).catch(() => {});
  });
  active.once("exit", (code) => {
    if (worker === active) {
      void stopWorker(new Error(`session touched-files worker exited with code ${code}`)).catch(
        () => {},
      );
    }
  });
  worker = active;
  workerLeaseNamespace = leaseNamespace;
  return active;
}

export async function loadSessionTouchedFilesInWorker(
  scope: SessionTranscriptReadScope,
  cacheKey: string,
): Promise<SessionTouchedFile[]> {
  if (!acceptingRequests) {
    throw new Error("session touched-files worker is shutting down");
  }
  await closing;
  await stopping;
  if (!acceptingRequests) {
    throw new Error("session touched-files worker is shutting down");
  }
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++;
    const active = ensureWorker();
    const stateDirectory = scope.env?.OPENCLAW_STATE_DIR ?? "";
    workerLeaseEnvironments.set(stateDirectory, scope.env);
    const timeout = setTimeout(() => {
      if (!pending.has(requestId)) {
        return;
      }
      void stopWorker(new Error("session touched-files worker timed out")).catch(() => {});
    }, REQUEST_TIMEOUT_MS);
    timeout.unref();
    pending.set(requestId, { timeout, resolve, reject });
    const request: SessionTouchedFilesWorkerRequest = {
      type: "load",
      requestId,
      scope,
      cacheKey,
    };
    active.postMessage(request, []);
  });
}

export async function closeSessionTouchedFilesWorker(): Promise<void> {
  if (stopping) {
    await stopping;
  }
  if (closing) {
    return await closing;
  }
  const active = worker;
  if (!active) {
    const activeStop = stopping;
    if (activeStop) {
      const cleanupError = await activeStop;
      if (cleanupError) {
        throw cleanupError;
      }
    }
    return;
  }
  closing = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = async () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      active.removeListener("message", onMessage);
      if (worker === active) {
        const cleanupError = await stopWorkerNow(new Error("session touched-files worker closed"));
        if (cleanupError) {
          reject(cleanupError);
          return;
        }
      } else if (stopping) {
        const cleanupError = await stopping;
        if (cleanupError) {
          reject(cleanupError);
          return;
        }
      }
      resolve();
    };
    const onMessage = (message: SessionTouchedFilesWorkerResult) => {
      if (message.type === "stopped") {
        void finish();
      }
    };
    const timeout = setTimeout(() => void finish(), SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    active.on("message", onMessage);
    active.postMessage({ type: "shutdown" }, []);
  }).finally(() => {
    closing = undefined;
  });
  return await closing;
}

export async function shutdownSessionTouchedFilesWorker(): Promise<void> {
  acceptingRequests = false;
  gatewayOwners = 0;
  await closeSessionTouchedFilesWorker();
}

/** Own worker admission for exactly one Gateway lifecycle. */
export function acquireSessionTouchedFilesWorkerForGateway(): () => Promise<void> {
  gatewayOwners += 1;
  acceptingRequests = true;
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    gatewayOwners = Math.max(0, gatewayOwners - 1);
    if (gatewayOwners > 0) {
      return;
    }
    acceptingRequests = false;
    await closeSessionTouchedFilesWorker();
  };
}

export async function terminateSessionTouchedFilesWorkerForTest(): Promise<void> {
  const cleanupError = await stopWorker(new Error("session touched-files worker test termination"));
  if (cleanupError) {
    throw cleanupError;
  }
}

export async function resetSessionTouchedFilesWorkerRuntimeForTest(): Promise<void> {
  await closeSessionTouchedFilesWorker();
  gatewayOwners = 0;
  acceptingRequests = true;
}
