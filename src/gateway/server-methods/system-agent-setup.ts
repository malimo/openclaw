import {
  ErrorCodes,
  errorShape,
  validateSystemAgentSetupActivateParams,
  validateSystemAgentSetupAuthStartParams,
  validateSystemAgentSetupDetectParams,
  validateSystemAgentSetupVerifyParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { WizardSession } from "../../wizard/session.js";
import {
  runExclusiveSystemAgentSetupActivation,
  SETUP_ADMISSION_BUSY_MESSAGE,
  SetupAdmissionBusyError,
} from "./setup-admission.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";
import { admitWizard } from "./system-agent-session-lifecycle.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const PROVIDER_AUTH_SESSION_TIMEOUT_MS = 25 * 60 * 1000;
const PROVIDER_PREPARE_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function respondRetryableSetupUnavailable(respond: RespondFn, message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, { retryable: true }));
}

export const systemAgentSetupHandlers: GatewayRequestHandlers = {
  /** Structured onboarding: list reusable AI access on this host. */
  "openclaw.setup.detect": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupDetectParams,
        "openclaw.setup.detect",
        respond,
      )
    ) {
      return;
    }
    // Detection is read-only and may load native provider code. Keep it outside
    // the mutation lane and off the Gateway event loop so health stays live.
    const { detectSetupInferenceIsolated } =
      await import("../../system-agent/setup-inference-detection.js");
    respond(true, await detectSetupInferenceIsolated(), undefined);
  },
  /** Re-run the exact current default-agent inference route without mutating setup. */
  "openclaw.setup.verify": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupVerifyParams,
        "openclaw.setup.verify",
        respond,
      )
    ) {
      return;
    }
    await runSystemAgentGatewayTask(async () => {
      const { verifySetupInference } = await import("../../system-agent/setup-inference.js");
      respond(true, await verifySetupInference({ runtime: defaultRuntime }), undefined);
    });
  },
  /** Start one provider-owned OAuth/device-code login over the shared wizard transport. */
  "openclaw.setup.auth.start": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "openclaw.setup.auth.start",
        respond,
      )
    ) {
      return;
    }
    const session = await admitWizard(
      context.wizardSessions,
      params.sessionId,
      () =>
        new WizardSession(
          async (prompter, signal, runnerSession) => {
            const result = await runSystemAgentGatewayTask(async () => {
              const { activateSetupInference } =
                await import("../../system-agent/setup-inference.js");
              return await activateSetupInference({
                kind: "provider-auth",
                authChoice: params.authChoice,
                ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
                surface: "gateway",
                runtime: {
                  ...defaultRuntime,
                  exit: (code: number | undefined): never => {
                    throw new Error(`setup step exited with code ${String(code)}`);
                  },
                },
                prompter,
                signal,
                isCancelled: () => signal.aborted,
                onCommitStarted: () => runnerSession.lockCancellation(),
              });
            });
            if (!result.ok) {
              throw new Error(result.error);
            }
          },
          { timeoutMs: PROVIDER_AUTH_SESSION_TIMEOUT_MS },
        ),
    );
    if (!session) {
      respondRetryableSetupUnavailable(respond, SETUP_ADMISSION_BUSY_MESSAGE);
      return;
    }
    // Return ownership immediately so the client can cancel while provider auth waits.
    respond(true, { sessionId: params.sessionId, done: false, status: "running" }, undefined);
  },
  /** Run one provider-owned prepare flow over the shared wizard transport. */
  "openclaw.setup.prepare.start": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "openclaw.setup.prepare.start",
        respond,
      )
    ) {
      return;
    }
    const session = await admitWizard(
      context.wizardSessions,
      params.sessionId,
      () =>
        new WizardSession(
          async (prompter, signal, runnerSession) => {
            await runSystemAgentGatewayTask(async () => {
              const [{ applyAuthChoiceLoadedPluginProvider }, setupShared] = await Promise.all([
                import("../../plugins/provider-auth-choice.js"),
                import("../../wizard/setup.shared.js"),
              ]);
              const snapshot = await setupShared.readSetupConfigFileSnapshot();
              if (!snapshot.valid) {
                throw new Error(
                  "Config is invalid. Run `openclaw doctor` before preparing a model.",
                );
              }
              // Match the classic wizard: mutate the authored shape, not runtimeConfig,
              // so setup never writes resolved runtime defaults into openclaw.json.
              const baseConfig = snapshot.exists ? snapshot.sourceConfig : {};
              const workspaceDir = params.workspace?.trim()
                ? resolveUserPath(params.workspace.trim())
                : undefined;
              const applied = await applyAuthChoiceLoadedPluginProvider({
                authChoice: params.authChoice,
                config: baseConfig,
                prompter,
                runtime: {
                  ...defaultRuntime,
                  exit: (code: number | undefined): never => {
                    throw new Error(`setup step exited with code ${String(code)}`);
                  },
                },
                setDefaultModel: false,
                preserveExistingDefaultModel: true,
                ...(workspaceDir ? { workspaceDir } : {}),
                signal,
                isRemote: true,
                beforePersistentEffect: () => {
                  signal.throwIfAborted();
                  runnerSession.lockCancellation();
                },
              });
              if (!applied || applied.retrySelection) {
                throw new Error(
                  `Provider setup resolution failed for "${params.authChoice}". Run \`openclaw doctor --fix\`, restart the Gateway, and try again.`,
                );
              }
              signal.throwIfAborted();
              runnerSession.lockCancellation();
              await setupShared.writeWizardConfigFile(applied.config, {
                allowConfigSizeDrop: false,
                baseSnapshot: snapshot,
                ...(snapshot.hash ? { baseHash: snapshot.hash } : {}),
              });
              if (applied.agentModelOverride) {
                runnerSession.setPreparedModelRef(applied.agentModelOverride);
              }
            });
          },
          { timeoutMs: PROVIDER_PREPARE_SESSION_TIMEOUT_MS },
        ),
    );
    if (!session) {
      respondRetryableSetupUnavailable(respond, SETUP_ADMISSION_BUSY_MESSAGE);
      return;
    }
    respond(true, { sessionId: params.sessionId, done: false, status: "running" }, undefined);
  },
  /**
   * Structured onboarding: live-test one candidate and persist it on success.
   * Single-flight per gateway process because testing and persistence span
   * multiple config/plugin mutations. Concurrent callers fail fast instead of
   * queueing work that could outlive their RPC timeout. A failed attempt never
   * commits a broken model, managed plugin install, or setup state.
   */
  "openclaw.setup.activate": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupActivateParams,
        "openclaw.setup.activate",
        respond,
      )
    ) {
      return;
    }
    try {
      await runExclusiveSystemAgentSetupActivation(async () => {
        await runSystemAgentGatewayTask(async () => {
          const { activateSetupInference } = await import("../../system-agent/setup-inference.js");
          const runtime = {
            ...defaultRuntime,
            // Setup runs inside the gateway process; a failing sub-step must reject
            // the RPC, never exit the daemon.
            exit: (code: number | undefined): never => {
              throw new Error(`setup step exited with code ${String(code)}`);
            },
          };
          const result = await activateSetupInference({
            kind: params.kind,
            ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
            ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
            ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
            ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
            surface: "gateway",
            runtime,
          });
          respond(true, result, undefined);
        });
      });
    } catch (error) {
      if (!(error instanceof SetupAdmissionBusyError)) {
        throw error;
      }
      respondRetryableSetupUnavailable(respond, error.message);
    }
  },
};
