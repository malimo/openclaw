// Shared fixtures and mocks for OpenClaw Gateway setup and chat method tests.

import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginStateStoreForTests } from "../../plugin-state/plugin-state-store.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../../system-agent/system-agent.test-helpers.js";
import type {
  SystemAgentVerifiedInferenceBinding,
  SystemAgentVerifiedInferenceDeps,
} from "../../system-agent/verified-inference.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const setupInferenceMocks = vi.hoisted(() => ({
  activateSetupInference: vi.fn(),
  resolvePersistentApplyInference: vi.fn(),
  verifySetupInference: vi.fn(),
}));
const inferenceFallbackMocks = vi.hoisted(() => ({ verify: vi.fn() }));
const setupInferenceDetectionMocks = vi.hoisted(() => ({
  detectSetupInferenceIsolated: vi.fn(),
}));
const providerAuthChoiceMocks = vi.hoisted(() => ({
  applyAuthChoiceLoadedPluginProvider: vi.fn(),
}));
const setupSharedMocks = vi.hoisted(() => ({
  readSetupConfigFileSnapshot: vi.fn(),
  writeWizardConfigFile: vi.fn(),
}));
const transcriptStoreMocks = vi.hoisted(() => ({
  appendTranscriptReset: vi.fn(),
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn<
    (limit: number) => Array<{ role: "user" | "assistant"; text: string; at: number }>
  >(() => []),
}));
const greetingMocks = vi.hoisted(() => ({
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  loadSystemAgentGreetingFacts: vi.fn(),
  resolveSystemAgentGreeting: vi.fn(),
}));
const onboardingWelcomeMocks = vi.hoisted(() => ({
  buildOnboardingWelcome: vi.fn(),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
  resolvePersistentApplyInference: setupInferenceMocks.resolvePersistentApplyInference,
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));
vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback: inferenceFallbackMocks.verify,
}));
vi.mock("../../system-agent/setup-inference-detection.js", () => ({
  detectSetupInferenceIsolated: setupInferenceDetectionMocks.detectSetupInferenceIsolated,
}));
vi.mock("../../plugins/provider-auth-choice.js", () => ({
  applyAuthChoiceLoadedPluginProvider: providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider,
}));
vi.mock("../../wizard/setup.shared.js", () => ({
  readSetupConfigFileSnapshot: setupSharedMocks.readSetupConfigFileSnapshot,
  writeWizardConfigFile: setupSharedMocks.writeWizardConfigFile,
}));
vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptReset: transcriptStoreMocks.appendTranscriptReset,
  appendTranscriptTurn: transcriptStoreMocks.appendTranscriptTurn,
  readTranscriptTail: transcriptStoreMocks.readTranscriptTail,
}));
vi.mock("../../system-agent/greeting.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../system-agent/greeting.js")>();
  return {
    ...actual,
    acknowledgeSystemAgentGreetingDelivery: greetingMocks.acknowledgeSystemAgentGreetingDelivery,
    loadSystemAgentGreetingFacts: greetingMocks.loadSystemAgentGreetingFacts,
    resolveSystemAgentGreeting: greetingMocks.resolveSystemAgentGreeting,
  };
});
vi.mock("../../system-agent/onboarding-welcome.js", () => ({
  buildOnboardingWelcome: onboardingWelcomeMocks.buildOnboardingWelcome,
}));

export type RespondCall = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

export function makeRespond() {
  const calls: RespondCall[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  return { calls, respond };
}

export function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

export function makeWizardContext() {
  const wizardSessions = new Map();
  return {
    wizardSessions,
    context: {
      wizardSessions,
      findRunningWizard: () => undefined,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
    } as unknown as GatewayRequestContext,
  };
}

export function systemAgentHandler(method: keyof typeof systemAgentHandlers) {
  return expectDefined(systemAgentHandlers[method], `systemAgentHandlers["${method}"] invariant`);
}

export function systemAgentLane() {
  return getCommandLaneSnapshot(CommandLane.SystemAgent);
}

export const waitOneTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

export const defaultClient = {
  connId: "conn-test",
  connect: { device: { id: "device-test" } },
} as GatewayClient;

export const verifiedConfig: OpenClawConfig = {
  agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
  auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
};
let verifiedInference: SystemAgentVerifiedInferenceBinding | undefined;
let verifiedInferenceDeps: SystemAgentVerifiedInferenceDeps | undefined;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;
export const systemAgentTempDirs = useAutoCleanupTempDirTracker(afterEach);

export function requireVerifiedInferenceFixture(): SystemAgentVerifiedInferenceBinding {
  return expectDefined(verifiedInference, "verified inference fixture was not initialized");
}

export function requireVerifiedInferenceDeps(): SystemAgentVerifiedInferenceDeps {
  return {
    ...expectDefined(verifiedInferenceDeps, "verified inference dependencies were not initialized"),
    readConfigFileSnapshot: async () =>
      ({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        hash: "verified-config",
        config: verifiedConfig,
        runtimeConfig: verifiedConfig,
        sourceConfig: verifiedConfig,
        issues: [],
      }) as never,
  };
}

export function makeVerifiedEngine(): SystemAgentChatEngine {
  return new SystemAgentChatEngine({
    verifiedInference: requireVerifiedInferenceFixture(),
    deps: requireVerifiedInferenceDeps(),
  });
}

export async function runSensitiveChannelSetup(_channel: string, prompter: WizardPrompter) {
  await prompter.text({ message: "Bot token", sensitive: true });
}

export async function makeDeliveredQrEngine(): Promise<SystemAgentChatEngine> {
  const ownerSettled = createDeferred();
  const runnerFinished = createDeferred();
  const engine = new SystemAgentChatEngine(
    {
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: requireVerifiedInferenceDeps(),
      supportsQrCode: true,
    },
    {
      wizardDependencies: {
        runChannelSetupWizard: async (_channel, prompter) => {
          await prompter.qrCode?.({
            title: "Link a device",
            message: "Scan this QR code.",
            text: "https://example.test/pair",
            dismissed: ownerSettled.promise,
          });
          runnerFinished.resolve();
        },
      },
    },
  );
  const prompt = await engine.handle("connect telegram");
  const stepId = expectDefined(prompt.step?.id, "QR step id");
  ownerSettled.resolve();
  await runnerFinished.promise;
  await waitOneTask();
  await engine.pollStep(stepId);
  await engine.resolveOperatorApproval(null, "queue-drain");
  const terminal = await engine.pollStep(stepId);
  expect(terminal).not.toMatchObject({ wizardSettling: true });
  expect(terminal).not.toHaveProperty("step");
  expect(terminal.text).toContain("is configured");
  expect(engine.historySince(0)).toContainEqual({ role: "assistant", text: terminal.text });
  await expect(engine.pollStep(stepId)).resolves.toEqual(terminal);
  return engine;
}

export function stubEngineOverview() {
  return vi.spyOn(SystemAgentChatEngine.prototype, "loadOverview").mockResolvedValue({
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    agents: [],
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    tools: {
      codex: { available: false },
      claude: { available: false },
      gemini: { available: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  } as never);
}

export function seededSession(overrides?: Partial<SystemAgentChatSession>): SystemAgentChatSession {
  return {
    engine: makeVerifiedEngine(),
    welcome: "welcome text",
    lastUsedAt: 1,
    ownerKey: "device:device-test",
    supportsQrCode: false,
    ...overrides,
  };
}

beforeAll(async () => {
  pluginMetadataSnapshot = installSystemAgentPluginMetadataTestSnapshot(verifiedConfig);
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedConfig);
  verifiedInference = fixture.binding;
  verifiedInferenceDeps = fixture.deps;
});

afterAll(() => {
  pluginMetadataSnapshot?.restore();
  verifiedInference = undefined;
  verifiedInferenceDeps = undefined;
});

beforeEach(() => {
  setupInferenceMocks.verifySetupInference.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 10,
    binding: verifiedInference,
  });
  inferenceFallbackMocks.verify.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 10,
    binding: verifiedInference,
  });
  setupInferenceMocks.resolvePersistentApplyInference.mockResolvedValue(
    requireVerifiedInferenceFixture().configuredRoute,
  );
  setupSharedMocks.readSetupConfigFileSnapshot.mockResolvedValue({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "prepare-base-hash",
    sourceConfig: verifiedConfig,
    config: verifiedConfig,
    issues: [],
  });
  setupSharedMocks.writeWizardConfigFile.mockImplementation(async (config) => config);
  transcriptStoreMocks.appendTranscriptTurn.mockReset();
  transcriptStoreMocks.appendTranscriptReset.mockReset();
  transcriptStoreMocks.readTranscriptTail.mockReset().mockReturnValue([]);
  greetingMocks.acknowledgeSystemAgentGreetingDelivery.mockReset();
  greetingMocks.loadSystemAgentGreetingFacts.mockReset().mockReturnValue({
    updateAvailable: null,
    channelHealth: { available: true, degraded: [] },
    recentExternalEdit: false,
    auditSequence: 0,
  });
  greetingMocks.resolveSystemAgentGreeting.mockReset().mockResolvedValue({
    text: "I'm OpenClaw. All systems nominal.",
    source: "model",
  });
  onboardingWelcomeMocks.buildOnboardingWelcome.mockReset().mockResolvedValue({
    text: "Inference is ready. Let's finish setup.",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  resetPluginStateStoreForTests();
  resetCommandQueueStateForTest();
  vi.unstubAllEnvs();
  pluginMetadataSnapshot?.rebindForCurrentEnv();
});

export async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  client: GatewayClient | null = defaultClient,
): Promise<RespondCall> {
  const { calls, respond } = makeRespond();
  await systemAgentHandler("openclaw.chat")({
    params,
    respond,
    context,
    client,
  } as never);
  const call = calls[0];
  if (!call) {
    throw new Error("expected a respond call");
  }
  return call;
}

export {
  greetingMocks,
  inferenceFallbackMocks,
  onboardingWelcomeMocks,
  providerAuthChoiceMocks,
  setupInferenceDetectionMocks,
  setupInferenceMocks,
  setupSharedMocks,
  transcriptStoreMocks,
};
