import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
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
} from "./session-touched-files-worker-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  closeSessionTouchedFilesWorker();
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
});
