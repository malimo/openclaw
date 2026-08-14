import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  closeSessionTouchedFilesWorker,
  loadSessionTouchedFilesInWorker,
  terminateSessionTouchedFilesWorkerForTest,
} from "./session-touched-files-worker-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await closeSessionTouchedFilesWorker();
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
    await terminateSessionTouchedFilesWorkerForTest();
    closeOpenClawAgentDatabasesForTest();

    expect(() => assertNoOpenClawAgentDatabaseLeases("main", { env })).not.toThrow();
  });
});
