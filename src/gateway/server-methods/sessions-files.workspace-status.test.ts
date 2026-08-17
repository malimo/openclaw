import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectOkPayload,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readSessionTranscriptVisibleMessageDeltaCore: vi.fn(),
  runGit: vi.fn(),
}));

vi.mock("../../agents/worktrees/git.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/worktrees/git.js")>(
    "../../agents/worktrees/git.js",
  );
  hoisted.runGit.mockImplementation(actual.runGit);
  return { ...actual, runGit: hoisted.runGit };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    readSessionTranscriptVisibleMessageDeltaCore:
      hoisted.readSessionTranscriptVisibleMessageDeltaCore,
  };
});

const invokeSessionFilesHandler = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const mockVisibleMessages = createVisibleMessagesMock(
  hoisted.readSessionTranscriptVisibleMessageDeltaCore,
);

describe("sessions.workspace.status RPC handler", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
  });

  afterEach(() => {
    removeWorkspaceFixture(workspaceRoot);
  });

  it("reports checkout status without reading the session transcript", async () => {
    const initialPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.workspace.status", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(initialPayload).toEqual({
      sessionKey: "agent:main:main",
      root: workspaceRoot,
      gitCheckout: false,
    });
    expect(hoisted.readSessionTranscriptVisibleMessageDeltaCore).not.toHaveBeenCalled();

    const gitInit = await import("node:child_process").then(({ execFileSync }) =>
      execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot }),
    );
    expect(gitInit).toBeInstanceOf(Buffer);

    const checkoutPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.workspace.status", {
        sessionKey: "agent:main:main",
      }),
    );
    expect(checkoutPayload.gitCheckout).toBe(true);
    expect(hoisted.readSessionTranscriptVisibleMessageDeltaCore).not.toHaveBeenCalled();

    fs.rmSync(path.join(workspaceRoot, ".git"), { force: true, recursive: true });
    const removedCheckoutPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.workspace.status", {
        sessionKey: "agent:main:main",
      }),
    );
    expect(removedCheckoutPayload.gitCheckout).toBe(false);
  });

  it("detects nested checkouts without spawning Git", async () => {
    const checkoutRoot = path.join(workspaceRoot, "checkout");
    const nestedRoot = path.join(checkoutRoot, "packages", "app");
    fs.mkdirSync(nestedRoot, { recursive: true });
    fs.mkdirSync(path.join(checkoutRoot, ".git"));
    hoisted.loadSessionEntry.mockImplementation((sessionKey: string) => {
      return {
        agentId: "main",
        canonicalKey: sessionKey,
        cfg: {},
        storePath: path.join(workspaceRoot, ".sessions.json"),
        entry: {
          sessionId: "nested-checkout",
          sessionFile: "nested-checkout.jsonl",
          spawnedCwd: nestedRoot,
        },
      };
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.workspace.status", {
        sessionKey: "agent:main:nested-checkout",
      }),
    );
    expect(payload.gitCheckout).toBe(true);
    expect(hoisted.runGit).not.toHaveBeenCalled();
  });
});
