import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { z } from "zod";
import { resolveSignalCliConfigPath } from "./signal-cli-config-path.js";

type SignalCliLinkResult = { ok: true; associatedAccount: string } | { ok: false; error: string };
type SignalCliAccountsResult = { ok: true; accounts: string[] } | { ok: false; error: string };

type SignalCliLinkCompletion = Promise<void>;

const SIGNAL_LINK_URI_PREFIX = "sgnl://linkdevice?";
// Wizard notes become system-agent history, so keep dependency diagnostics well below the
// repository's per-item model-context budget while retaining the actionable stderr tail.
const SIGNAL_LINK_ERROR_OUTPUT_LIMIT = 2_000;
const SIGNAL_CLI_LINK_STDOUT_LIMIT_BYTES = 8 * 1024;
const SIGNAL_CLI_LINK_QR_TIMEOUT_MS = 120_000;
// signal-cli waits up to 30 seconds for the link URI, then 120 seconds for provisioning.
// Leave a small startup/write buffer while still bounding hangs before either timeout starts.
const SIGNAL_CLI_LINK_TIMEOUT_MS = 3 * 60_000;
const SIGNAL_CLI_LIST_TIMEOUT_MS = 10_000;
const SignalCliAccountsSchema = z.array(z.object({ number: z.string().regex(/^\+\d{5,15}$/u) }));
let signalCliLinkActive = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalCliArgs(configPath: string | undefined): string[] {
  return configPath?.trim() ? ["--config", resolveSignalCliConfigPath(configPath)] : [];
}

export async function listSignalCliAccounts(params: {
  cliPath: string;
  configPath?: string;
  signal?: AbortSignal;
}): Promise<SignalCliAccountsResult> {
  try {
    const result = await runCommandWithTimeout(
      [params.cliPath, ...signalCliArgs(params.configPath), "--output", "json", "listAccounts"],
      {
        ...(params.signal ? { signal: params.signal } : {}),
        killProcessTree: true,
        timeoutMs: SIGNAL_CLI_LIST_TIMEOUT_MS,
        maxOutputBytes: { stdout: 16 * 1024, stderr: SIGNAL_LINK_ERROR_OUTPUT_LIMIT },
        outputCapture: { stdout: "head", stderr: "tail" },
        terminateOnOutputLimit: { stdout: true },
      },
    );
    if (result.code !== 0 || result.termination !== "exit") {
      return {
        ok: false,
        error: result.stderr.trim() || "signal-cli could not inspect its linked accounts.",
      };
    }
    const parsed = SignalCliAccountsSchema.safeParse(JSON.parse(result.stdout));
    return parsed.success
      ? { ok: true, accounts: parsed.data.map((account) => account.number) }
      : { ok: false, error: "signal-cli returned an invalid account list." };
  } catch (error) {
    return { ok: false, error: `Could not inspect signal-cli accounts: ${errorMessage(error)}` };
  }
}

export async function linkSignalCliAccount(params: {
  cliPath: string;
  configPath?: string;
  signal?: AbortSignal;
  onLinkUri: (
    uri: string,
    completion: SignalCliLinkCompletion,
    expiresAtMs: number,
  ) => Promise<void>;
}): Promise<SignalCliLinkResult> {
  if (params.signal?.aborted) {
    return { ok: false, error: "Signal account linking was cancelled." };
  }
  // signal-cli chooses its implicit store from process environment. Serialize linking globally
  // so implicit and explicit aliases cannot mutate the same dependency-owned store concurrently.
  if (signalCliLinkActive) {
    return { ok: false, error: "Signal account linking is already in progress." };
  }
  signalCliLinkActive = true;

  const commandAbort = new AbortController();
  let displayError: string | undefined;
  let displayPromise = Promise.resolve();
  let linkUriSeen = false;
  let associatedAccount: string | undefined;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((complete) => {
    resolveCompletion = complete;
  });
  const stopWithError = (error: string) => {
    if (displayError) {
      return;
    }
    displayError = error;
    resolveCompletion();
    commandAbort.abort();
  };
  const abort = () => stopWithError("Signal account linking was cancelled.");
  params.signal?.addEventListener("abort", abort, { once: true });

  const processLine = (line: string) => {
    if (displayError) {
      return;
    }
    const trimmed = line.trim();
    if (!linkUriSeen && trimmed.startsWith(SIGNAL_LINK_URI_PREFIX)) {
      linkUriSeen = true;
      displayPromise = Promise.resolve()
        .then(
          async () =>
            await params.onLinkUri(trimmed, completion, Date.now() + SIGNAL_CLI_LINK_QR_TIMEOUT_MS),
        )
        .catch((error: unknown) => {
          stopWithError(`Signal account linking stopped: ${errorMessage(error)}`);
        });
      return;
    }
    const associatedMatch = /^Associated with:\s*(\+\d{5,15})$/iu.exec(trimmed);
    if (associatedMatch?.[1]) {
      associatedAccount = associatedMatch[1];
    }
  };
  try {
    // This repository-owned runner is the lifecycle owner: cancellation terminates wrapped
    // launchers and their descendants before returning, including on Windows.
    const result = await runCommandWithTimeout(
      [
        params.cliPath,
        ...signalCliArgs(params.configPath),
        "--output",
        "plain-text",
        "link",
        "-n",
        "OpenClaw",
      ],
      {
        signal: commandAbort.signal,
        killProcessTree: true,
        timeoutMs: SIGNAL_CLI_LINK_TIMEOUT_MS,
        outputCapture: { stdout: "discard", stderr: "tail" },
        maxOutputBytes: {
          stdout: SIGNAL_CLI_LINK_STDOUT_LIMIT_BYTES,
          stderr: SIGNAL_LINK_ERROR_OUTPUT_LIMIT,
        },
        terminateOnOutputLimit: { stdout: true },
        maxPreservedOutputLines: 1,
        preserveOutputLine: (line, stream) => {
          if (stream === "stdout") {
            processLine(line);
          }
          // The runner owns UTF-8 decoding and bounded line framing. Signal consumes matching
          // markers immediately, so no line needs to be copied into the command result.
          return false;
        },
      },
    );
    resolveCompletion();
    await displayPromise;

    if (associatedAccount) {
      // signal-cli emits this marker only after finishDeviceLink returns. The linked account is
      // therefore durable even when a late presentation failure terminates the settling process.
      return { ok: true, associatedAccount };
    }
    if (result.code === 0 && result.termination === "exit") {
      if (!linkUriSeen) {
        return {
          ok: false,
          error: "signal-cli link finished without producing a device-link QR code.",
        };
      }
      return {
        ok: false,
        error: "signal-cli link finished without reporting the associated account.",
      };
    }
    if (displayError) {
      return { ok: false, error: displayError };
    }
    if (result.outputLimitExceeded) {
      return { ok: false, error: "signal-cli link exceeded its 8 KiB output limit." };
    }
    if (result.termination === "timeout") {
      return { ok: false, error: "Signal account linking timed out." };
    }
    return {
      ok: false,
      error:
        result.stderr.trim() ||
        `signal-cli link exited with ${result.signal ? `signal ${result.signal}` : `code ${result.code ?? "unknown"}`}.`,
    };
  } catch (error) {
    resolveCompletion();
    await displayPromise;
    if (displayError) {
      return { ok: false, error: displayError };
    }
    return { ok: false, error: `Could not start signal-cli: ${errorMessage(error)}` };
  } finally {
    params.signal?.removeEventListener("abort", abort);
    signalCliLinkActive = false;
  }
}
