import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import * as agentDatabaseLease from "../../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  acquireSessionTouchedFilesWorkerForGateway,
  closeSessionTouchedFilesWorker,
  loadSessionTouchedFilesInWorker,
  terminateSessionTouchedFilesWorkerForTest,
} from "./session-touched-files-worker-runtime.js";

const temporaryDirectories: string[] = [];
let releaseGatewayWorker: (() => Promise<void>) | undefined;

beforeEach(() => {
  releaseGatewayWorker = acquireSessionTouchedFilesWorkerForGateway();
});

afterEach(async () => {
  await releaseGatewayWorker?.();
  releaseGatewayWorker = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("session touched-files worker runtime", () => {
  it("folds real SQLite messages off-thread and preserves its incremental cursor", async () => {
    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "openclaw-touched-worker-"),
    );
    temporaryDirectories.push(directory);
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    openOpenClawStateDatabase({ env });
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const scope = {
      agentId: "main",
      env,
      sessionId: "worker-session",
      sessionKey: "agent:main:worker-session",
    };
    const cacheKey = `main\0worker-session\0${storePath}`;

    await appendTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "src/file.ts" } }],
      },
    });

    await expect(loadSessionTouchedFilesInWorker(scope, cacheKey)).resolves.toEqual([
      { path: "src/file.ts", kind: "read" },
    ]);

    await appendTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts" } }],
      },
    });

    await expect(loadSessionTouchedFilesInWorker(scope, cacheKey)).resolves.toEqual([
      { path: "src/file.ts", kind: "modified" },
    ]);
  });

  it("releases worker-held agent database leases before closing", async () => {
    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "openclaw-touched-worker-close-"),
    );
    temporaryDirectories.push(directory);
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    openOpenClawStateDatabase({ env });
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const scope = {
      agentId: "main",
      env,
      sessionId: "worker-close-session",
      sessionKey: "agent:main:worker-close-session",
    };

    await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: [] },
    });
    await loadSessionTouchedFilesInWorker(scope, `main\0worker-close-session\0${storePath}`);
    await closeSessionTouchedFilesWorker();

    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare(
          "SELECT COUNT(*) AS count FROM agent_database_leases WHERE agent_id = ? AND path = ?",
        )
        .get("main", storePath),
    ).toEqual({ count: 1 });
  });

  it("waits for a load admitted before worker creation", async () => {
    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "openclaw-touched-worker-admission-"),
    );
    temporaryDirectories.push(directory);
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    openOpenClawStateDatabase({ env });
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const scope = {
      agentId: "main",
      env,
      sessionId: "worker-admission-session",
      sessionKey: "agent:main:worker-admission-session",
    };
    await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: [] },
    });

    const load = loadSessionTouchedFilesInWorker(
      scope,
      `main\0worker-admission-session\0${storePath}`,
    );
    let closeCompleted = false;
    const close = closeSessionTouchedFilesWorker().then(() => {
      closeCompleted = true;
    });
    await Promise.resolve();
    expect(closeCompleted).toBe(false);

    await expect(load).resolves.toEqual([]);
    await close;
    expect(closeCompleted).toBe(true);
  });

  it("retires only worker-owned leases after forced termination", async () => {
    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "openclaw-touched-worker-terminate-"),
    );
    temporaryDirectories.push(directory);
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    openOpenClawStateDatabase({ env });
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const scope = {
      agentId: "main",
      env,
      sessionId: "worker-terminate-session",
      sessionKey: "agent:main:worker-terminate-session",
    };

    await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: [] },
    });
    await loadSessionTouchedFilesInWorker(scope, `main\0worker-terminate-session\0${storePath}`);
    let releaseTermination: () => void = () => {};
    const terminationGate = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminateSpy = vi
      .spyOn(Worker.prototype, "terminate")
      .mockImplementation(function (this: Worker) {
        return terminationGate.then(() => {
          terminateSpy.mockRestore();
          return this.terminate();
        });
      });
    try {
      const termination = terminateSessionTouchedFilesWorkerForTest();
      let closeCompleted = false;
      const close = closeSessionTouchedFilesWorker().then(() => {
        closeCompleted = true;
      });
      await Promise.resolve();
      expect(closeCompleted).toBe(false);

      releaseTermination();
      await Promise.all([termination, close]);
    } finally {
      releaseTermination();
      terminateSpy.mockRestore();
    }

    await loadSessionTouchedFilesInWorker(scope, `main\0worker-terminate-session\0${storePath}`);
    let releaseSecondTermination: () => void = () => {};
    const secondTerminationGate = new Promise<void>((resolve) => {
      releaseSecondTermination = resolve;
    });
    const secondTerminateSpy = vi
      .spyOn(Worker.prototype, "terminate")
      .mockImplementation(function (this: Worker) {
        return secondTerminationGate.then(() => {
          secondTerminateSpy.mockRestore();
          return this.terminate();
        });
      });
    try {
      let closeCompleted = false;
      const close = closeSessionTouchedFilesWorker().then(() => {
        closeCompleted = true;
      });
      const termination = terminateSessionTouchedFilesWorkerForTest();
      await Promise.resolve();
      expect(closeCompleted).toBe(false);

      releaseSecondTermination();
      await Promise.all([close, termination]);
    } finally {
      releaseSecondTermination();
      secondTerminateSpy.mockRestore();
    }
    closeOpenClawAgentDatabasesForTest();

    expect(() =>
      agentDatabaseLease.assertNoOpenClawAgentDatabaseLeases("main", { env }),
    ).not.toThrow();
  });

  it.each(["forced stop starts first", "graceful close starts first"] as const)(
    "propagates cleanup failure when %s",
    async (ordering) => {
      const directory = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "openclaw-touched-worker-cleanup-error-"),
      );
      temporaryDirectories.push(directory);
      const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
      openOpenClawStateDatabase({ env });
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      const scope = {
        agentId: "main",
        env,
        sessionId: "worker-cleanup-error-session",
        sessionKey: "agent:main:worker-cleanup-error-session",
      };
      await appendTranscriptMessage(scope, {
        message: { role: "assistant", content: [] },
      });
      await loadSessionTouchedFilesInWorker(
        scope,
        `main\0worker-cleanup-error-session\0${storePath}`,
      );
      const releaseSpy = vi
        .spyOn(agentDatabaseLease, "releaseOpenClawAgentDatabaseLeasesByNamespace")
        .mockImplementationOnce(() => {
          throw new Error("lease cleanup failed for test");
        });
      try {
        let close: Promise<void>;
        let terminationResult: Promise<unknown>;
        if (ordering === "forced stop starts first") {
          terminationResult = terminateSessionTouchedFilesWorkerForTest().catch(
            (error: unknown) => error,
          );
          close = closeSessionTouchedFilesWorker();
        } else {
          close = closeSessionTouchedFilesWorker();
          terminationResult = terminateSessionTouchedFilesWorkerForTest().catch(
            (error: unknown) => error,
          );
        }

        await expect(close).rejects.toThrow(
          "failed to release terminated session worker database leases",
        );
        await expect(terminationResult).resolves.toBeInstanceOf(Error);
      } finally {
        releaseSpy.mockRestore();
      }
    },
  );

  it("re-enables worker admission for a restarted Gateway", async () => {
    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "openclaw-touched-worker-restart-"),
    );
    temporaryDirectories.push(directory);
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    openOpenClawStateDatabase({ env });
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const restartedScope = {
      agentId: "main",
      env,
      sessionId: "restarted-session",
      sessionKey: "agent:main:restarted-session",
    };
    await appendTranscriptMessage(restartedScope, {
      message: { role: "assistant", content: [] },
    });
    await releaseGatewayWorker?.();
    releaseGatewayWorker = undefined;

    await expect(
      loadSessionTouchedFilesInWorker(
        {
          agentId: "main",
          sessionId: "stopped-session",
          sessionKey: "agent:main:stopped-session",
        },
        "main\0stopped-session",
      ),
    ).rejects.toThrow("worker is shutting down");

    releaseGatewayWorker = acquireSessionTouchedFilesWorkerForGateway();
    await expect(
      loadSessionTouchedFilesInWorker(restartedScope, `main\0restarted-session\0${storePath}`),
    ).resolves.toEqual([]);
  });
});
