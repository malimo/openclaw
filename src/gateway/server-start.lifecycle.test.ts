import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  createGatewayHttpTransport: vi.fn(),
  createGatewayKernel: vi.fn(),
  finishGatewayStartup: vi.fn(),
  logger: { warn: vi.fn() },
  runGlobalGatewayStopSafely: vi.fn(),
}));

vi.mock("./server-kernel.js", () => ({
  createGatewayKernel: mocks.createGatewayKernel,
  gatewayKernelLogs: {
    log: mocks.logger,
    logChannels: mocks.logger,
    logCron: mocks.logger,
    logHealth: mocks.logger,
    logHooks: mocks.logger,
    logReload: mocks.logger,
    logTailscale: mocks.logger,
    logWsControl: mocks.logger,
  },
  resetPreparedModelCatalogForTestCore: vi.fn(),
}));

vi.mock("./server-runtime-state.js", () => ({
  createGatewayHttpTransport: mocks.createGatewayHttpTransport,
}));

vi.mock("./server-startup-finish.js", () => ({
  finishGatewayStartup: mocks.finishGatewayStartup,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  runGlobalGatewayStopSafely: mocks.runGlobalGatewayStopSafely,
}));

import { startGatewayServerCore } from "./server-start.js";

function createKernel() {
  const close = vi.fn(async () => {
    mocks.calls.push("sockets");
  });
  return {
    beginClosePrelude: vi.fn(async () => {
      mocks.calls.push("session-retirement");
    }),
    clearFallbackGatewayContextForServer: {
      get: () => () => mocks.calls.push("fallback-context"),
    },
    closeOnStartupFailure: vi.fn(async () => {
      mocks.calls.push("startup-cleanup");
    }),
    createCloseHandler: () => close,
    createHttpTransportOptions: () => ({}),
    runClosePrelude: vi.fn(async () => {
      mocks.calls.push("close-prelude");
    }),
    stopRegisteredGatewayLifetimeSidecars: vi.fn(async () => {
      mocks.calls.push("gateway-sidecars");
    }),
    stopRegisteredPostReadySidecars: vi.fn(async () => {
      mocks.calls.push("post-ready-sidecars");
    }),
    terminalSessions: {
      disposeAll: vi.fn(() => mocks.calls.push("terminal-shells")),
    },
    transportBridge: {
      attach: vi.fn(),
    },
  };
}

describe("Gateway outer lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.createGatewayHttpTransport.mockResolvedValue({});
    mocks.finishGatewayStartup.mockResolvedValue(undefined);
    mocks.runGlobalGatewayStopSafely.mockImplementation(async () => {
      mocks.calls.push("plugin-stop-hooks");
    });
  });

  it("reports session retirement failure after essential close steps finish", async () => {
    const retirementError = new AggregateError(
      [new Error("engine disposal failed")],
      "session retirement failed",
    );
    const kernel = createKernel();
    kernel.beginClosePrelude.mockImplementationOnce(async () => {
      mocks.calls.push("session-retirement");
      throw retirementError;
    });
    mocks.createGatewayKernel.mockResolvedValue(kernel);
    const server = await startGatewayServerCore(18_789);

    await expect(server.close({ reason: "test shutdown" })).rejects.toBe(retirementError);

    expect(mocks.calls).toEqual([
      "session-retirement",
      "terminal-shells",
      "gateway-sidecars",
      "post-ready-sidecars",
      "plugin-stop-hooks",
      "close-prelude",
      "sockets",
      "fallback-context",
    ]);
  });

  it("preserves startup and cleanup failures after startup cleanup finishes", async () => {
    const startupError = new Error("startup failed");
    const retirementError = new AggregateError(
      [new Error("engine disposal failed")],
      "session retirement failed",
    );
    const kernel = createKernel();
    kernel.closeOnStartupFailure.mockImplementationOnce(async () => {
      mocks.calls.push("startup-cleanup");
      throw retirementError;
    });
    mocks.createGatewayKernel.mockResolvedValue(kernel);
    mocks.finishGatewayStartup.mockRejectedValueOnce(startupError);

    const failure = await startGatewayServerCore(18_789).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([startupError, retirementError]);
    expect(mocks.calls).toEqual(["startup-cleanup"]);
  });
});
