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
  });

  it("coalesces cold checkout probes and reuses the positive result", async () => {
    let finishProbe: (result: { code: number; stderr: string; stdout: string }) => void = () => {};
    hoisted.runGit.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );

    const first = invokeSessionFilesHandler("sessions.workspace.status", {
      sessionKey: "agent:main:main",
    });
    const second = invokeSessionFilesHandler("sessions.workspace.status", {
      sessionKey: "agent:main:main",
    });
    await vi.waitFor(() => expect(hoisted.runGit).toHaveBeenCalledOnce());

    finishProbe({ code: 0, stderr: "", stdout: `${workspaceRoot}\n` });
    const [firstPayload, secondPayload] = await Promise.all([
      first.then(expectOkPayload),
      second.then(expectOkPayload),
    ]);
    expect(firstPayload.gitCheckout).toBe(true);
    expect(secondPayload).toEqual(firstPayload);

    const cachedPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.workspace.status", {
        sessionKey: "agent:main:main",
      }),
    );
    expect(cachedPayload).toEqual(firstPayload);
    expect(hoisted.runGit).toHaveBeenCalledOnce();
  });

  it("does not queue a healthy workspace behind stalled probes", async () => {
    let releaseProbes: () => void = () => {};
    const probeGate = new Promise<void>((resolve) => {
      releaseProbes = resolve;
    });
    hoisted.loadSessionEntry.mockImplementation((sessionKey: string) => {
      const sessionId = sessionKey.split(":").at(-1) ?? "main";
      const sessionRoot = path.join(workspaceRoot, sessionId);
      return {
        agentId: "main",
        canonicalKey: sessionKey,
        cfg: {},
        storePath: path.join(workspaceRoot, ".sessions.json"),
        entry: {
          sessionId,
          sessionFile: `${sessionId}.jsonl`,
          spawnedCwd: sessionRoot,
        },
      };
    });
    const runPressureProbe = async (cwd: string) => {
      if (cwd.endsWith("pressure-4")) {
        return { code: 0, stderr: "", stdout: `${cwd}\n` };
      }
      await probeGate;
      return { code: 0, stderr: "", stdout: `${cwd}\n` };
    };

    await hoisted.runGit.withImplementation(runPressureProbe, async () => {
      const stalledRequests = Array.from({ length: 4 }, (_, index) =>
        invokeSessionFilesHandler("sessions.workspace.status", {
          sessionKey: `agent:main:pressure-${String(index)}`,
        }),
      );
      await vi.waitFor(() => expect(hoisted.runGit).toHaveBeenCalledTimes(4));

      const healthyPayload = expectOkPayload(
        await invokeSessionFilesHandler("sessions.workspace.status", {
          sessionKey: "agent:main:pressure-4",
        }),
      );
      expect(healthyPayload.gitCheckout).toBe(true);
      expect(hoisted.runGit).toHaveBeenCalledTimes(5);

      releaseProbes();
      await Promise.all(stalledRequests);
    });
  });
});
