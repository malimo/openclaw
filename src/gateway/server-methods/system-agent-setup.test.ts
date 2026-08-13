// OpenClaw Gateway tests cover structured setup method execution.

import "./system-agent.test-support.js";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime } from "../../runtime.js";
import {
  runExclusiveSystemAgentSetupActivation,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import {
  makeRespond,
  makeWizardContext,
  providerAuthChoiceMocks,
  setupInferenceDetectionMocks,
  setupInferenceMocks,
  setupSharedMocks,
  systemAgentHandler,
  systemAgentLane,
  verifiedConfig,
} from "./system-agent.test-support.js";

describe("openclaw.setup", () => {
  it("returns a retryable busy error while another activation is running", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const first = runExclusiveSystemAgentSetupActivation(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;

    try {
      const { calls, respond } = makeRespond();
      await systemAgentHandler("openclaw.setup.activate")({
        params: { kind: "claude-cli" },
        respond,
      } as never);

      expect(calls).toEqual([
        {
          ok: false,
          payload: undefined,
          error: {
            code: "UNAVAILABLE",
            message: "OpenClaw setup is already in progress; try again when it finishes.",
            retryable: true,
          },
        },
      ]);
    } finally {
      releaseFirst.resolve();
      await first;
    }
  });

  it.each([
    [
      "openclaw.setup.auth.start" as const,
      { sessionId: "busy-auth", authChoice: "github-copilot" },
    ],
    ["openclaw.setup.prepare.start" as const, { sessionId: "busy-prepare", authChoice: "ollama" }],
  ])("rejects %s before creating a wizard session when setup is busy", async (method, params) => {
    const ownerStarted = createDeferred();
    const releaseOwner = createDeferred();
    const owner = runExclusiveSystemAgentSetupActivation(async () => {
      ownerStarted.resolve();
      await releaseOwner.promise;
    });
    await ownerStarted.promise;
    const { wizardSessions, context } = makeWizardContext();

    try {
      const { calls, respond } = makeRespond();
      await systemAgentHandler(method)({ params, respond, context } as never);

      expect(calls).toEqual([
        {
          ok: false,
          payload: undefined,
          error: {
            code: "UNAVAILABLE",
            message: "OpenClaw setup is already in progress; try again when it finishes.",
            retryable: true,
          },
        },
      ]);
      expect(wizardSessions.size).toBe(0);
    } finally {
      releaseOwner.resolve();
      await owner;
    }
  });
  it("starts provider auth as an interactive wizard session", async () => {
    const { wizardSessions, context } = makeWizardContext();
    setupInferenceMocks.activateSetupInference.mockImplementationOnce(async (params) => {
      await params.prompter.note("Open the browser and enter ABCD", "Pair GitHub");
      return { ok: true, modelRef: "github-copilot/test", latencyMs: 10, lines: ["ready"] };
    });
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.auth.start")({
      params: { sessionId: "auth-session-1", authChoice: "github-copilot" },
      respond,
      context,
    } as never);

    expect(calls[0]).toMatchObject({
      ok: true,
      payload: { sessionId: "auth-session-1", done: false, status: "running" },
    });
    const session = wizardSessions.get("auth-session-1");
    const first = await session.next();
    expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "provider-auth", authChoice: "github-copilot" }),
    );
    expect(setupInferenceMocks.activateSetupInference.mock.calls[0]?.[0].signal).toBe(
      session.signal,
    );
    expect(first).toMatchObject({
      done: false,
      status: "running",
      step: { type: "note", title: "Pair GitHub", message: "Open the browser and enter ABCD" },
    });
    await session.answer(first.step.id, null);
    await expect(session.next()).resolves.toMatchObject({ done: true, status: "done" });
    await whenAdmittedWizardSessionSettled(session);
  });
  it("runs the selected provider method in a shared wizard session and commits its config", async () => {
    const preparedConfig: OpenClawConfig = {
      ...verifiedConfig,
      models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
    };
    providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider.mockImplementationOnce(
      async (params) => {
        await params.prompter.note("Model ready", "Ollama");
        await params.beforePersistentEffect();
        return { config: preparedConfig, agentModelOverride: "ollama/qwen3:0.6b" };
      },
    );
    const { wizardSessions, context } = makeWizardContext();
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.prepare.start")({
      params: {
        sessionId: "prepare-session-1",
        authChoice: "ollama",
        workspace: "/tmp/models-workspace",
      },
      respond,
      context,
    } as never);

    expect(calls[0]).toMatchObject({
      ok: true,
      payload: { sessionId: "prepare-session-1", done: false, status: "running" },
    });
    const session = wizardSessions.get("prepare-session-1");
    const note = await session.next();
    expect(note).toMatchObject({
      done: false,
      step: { type: "note", title: "Ollama", message: "Model ready" },
    });
    expect(providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "ollama",
        config: verifiedConfig,
        workspaceDir: "/tmp/models-workspace",
        setDefaultModel: false,
        preserveExistingDefaultModel: true,
        signal: session.signal,
        isRemote: true,
      }),
    );
    await session.answer(note.step.id, null);
    await expect(session.next()).resolves.toMatchObject({
      done: true,
      status: "done",
      preparedModelRef: "ollama/qwen3:0.6b",
    });
    await whenAdmittedWizardSessionSettled(session);
    expect(setupSharedMocks.writeWizardConfigFile).toHaveBeenCalledWith(preparedConfig, {
      allowConfigSizeDrop: false,
      baseSnapshot: expect.objectContaining({ hash: "prepare-base-hash" }),
      baseHash: "prepare-base-hash",
    });
    await whenAdmittedWizardSessionSettled(session);
  });
});

describe("openclaw.setup execution", () => {
  it("keeps read-only setup detection outside the serialized system-agent lane", async () => {
    const started = createDeferred();
    const release = createDeferred();
    setupInferenceDetectionMocks.detectSetupInferenceIsolated.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        candidates: [],
        unavailableCandidates: [],
        manualProviders: [],
        authOptions: [],
        prepareOptions: [],
        recommendedInstalls: [],
        workspace: "/tmp/work",
        setupComplete: false,
      };
    });
    const activeAtResponse: number[] = [];

    const pending = systemAgentHandler("openclaw.setup.detect")({
      params: {},
      respond: () => {
        activeAtResponse.push(systemAgentLane().activeCount);
      },
    } as never);

    await started.promise;
    expect(systemAgentLane().activeCount).toBe(0);
    release.resolve();
    await pending;

    expect(activeAtResponse).toEqual([0]);
    expect(systemAgentLane().activeCount).toBe(0);
  });

  it.each([
    {
      name: "working",
      result: { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 25 },
    },
    {
      name: "unavailable",
      result: {
        ok: false as const,
        status: "unavailable" as const,
        error: "no configured model",
      },
    },
  ])("returns the structured $name inference verification result", async ({ result }) => {
    setupInferenceMocks.verifySetupInference.mockResolvedValueOnce(result);
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.verify")({ params: {}, respond } as never);

    expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledWith({
      runtime: defaultRuntime,
    });
    expect(calls).toEqual([{ ok: true, payload: result, error: undefined }]);
  });

  it("rejects unknown setup verification params without running inference", async () => {
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.verify")({
      params: { modelRef: "openai/gpt-5.5" },
      respond,
    } as never);

    expect(setupInferenceMocks.verifySetupInference).not.toHaveBeenCalled();
    expect(calls[0]?.ok).toBe(false);
  });

  it("forwards setup activation on the gateway lane until its response is sent", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const activationResult = {
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 250,
      lines: ["Default model: openai/gpt-5.5"],
    };
    setupInferenceMocks.activateSetupInference.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return activationResult;
    });
    const { calls, respond } = makeRespond();
    const activeAtResponse: number[] = [];

    const pending = systemAgentHandler("openclaw.setup.activate")({
      params: {
        kind: "api-key",
        modelRef: "openai/gpt-5.5",
        authChoice: "openai-api-key",
        apiKey: "test-key",
        workspace: "/tmp/work",
      },
      respond: (ok: boolean, payload?: unknown, error?: unknown) => {
        activeAtResponse.push(systemAgentLane().activeCount);
        respond(ok, payload, error);
      },
    } as never);

    await started.promise;
    expect(systemAgentLane().activeCount).toBe(1);
    release.resolve();
    await pending;

    expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith({
      kind: "api-key",
      modelRef: "openai/gpt-5.5",
      authChoice: "openai-api-key",
      apiKey: "test-key",
      workspace: "/tmp/work",
      surface: "gateway",
      runtime: expect.objectContaining({ exit: expect.any(Function) }),
    });
    expect(calls).toEqual([{ ok: true, payload: activationResult, error: undefined }]);
    expect(activeAtResponse).toEqual([1]);
    expect(systemAgentLane().activeCount).toBe(0);
  });
});
