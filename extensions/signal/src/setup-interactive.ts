import { hostname, networkInterfaces } from "node:os";
import {
  patchChannelConfigForAccount,
  WizardCancelledError,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import {
  listSignalAccountIds,
  resolveSignalAccount,
  type ResolvedSignalTransport,
} from "./accounts.js";
import {
  assertSignalAccountNotAssignedToSibling,
  isSameSignalAccount,
  normalizeSignalAccountInput,
  signalSetupStateKeys,
} from "./setup-core.js";
import {
  detectSignalTransport,
  probeSignalTransport,
  type SignalTransportProbeResult,
  writeSignalAccountTransport,
} from "./setup-transport.js";
import { isSignalManagedNativeConnectionUrlForBind } from "./transport-policy.js";
import { normalizeSignalTransportUrl } from "./transport-url.js";

type SignalPrepareParams = Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0];
type SignalFinalizeParams = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0];
type SignalExistingTransport = Extract<
  SignalTransportConfig,
  { kind: "external-native" | "container" }
>;
type ExistingServerPromptParams = {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  initialValue?: string;
};

export async function finalizeSignalExistingServerSetup(params: SignalFinalizeParams) {
  const kind = params.credentialValues[signalSetupStateKeys.transportKind];
  let cfg = params.cfg;
  const resolvedAccount = resolveSignalAccount({
    cfg,
    accountId: params.accountId,
  });
  let account = normalizeSignalAccountInput(resolvedAccount.config.account) ?? undefined;
  if (kind !== "external-native" && kind !== "container") {
    throw new Error("Signal setup is missing its prepared transport candidate.");
  }
  const url = params.credentialValues[signalSetupStateKeys.serverUrl];
  if (!url) {
    throw new Error("Signal setup is missing its prepared transport candidate.");
  }
  let transport: SignalExistingTransport = { kind, url };
  let preservedUnverifiableServer = false;

  let shouldPromptAccount = !account;

  while (true) {
    // Account or URL recovery re-enters here so every probe sees matching candidate state.
    if (shouldPromptAccount) {
      account = await promptSignalAccount(params.prompter);
      cfg = patchChannelConfigForAccount({
        cfg,
        channel: "signal",
        accountId: params.accountId,
        patch: {
          account,
          ...(isSameSignalAccount(
            resolveSignalAccount({ cfg, accountId: params.accountId }).config.account,
            account,
          )
            ? {}
            : { accountUuid: undefined }),
        },
      });
      shouldPromptAccount = false;
    }
    if (!account) {
      throw new Error("Signal setup requires an account number before validation.");
    }
    assertSignalAccountNotAssignedToSibling({
      cfg,
      accountId: params.accountId,
      account,
    });

    const probe: SignalTransportProbeResult = await probeSignalTransport({
      cfg,
      accountId: params.accountId,
      transport,
      account,
    }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (probe.ok) {
      break;
    }
    if (
      probe.failureKind === "unverifiable-single-account" &&
      isUnchangedConfiguredExternalNative({
        credentialValues: params.credentialValues,
        account,
        transport,
      })
    ) {
      const preserve = await params.prompter.confirm({
        message: `Warning: the unchanged Signal server at ${transport.url} does not expose which account it serves, so OpenClaw cannot verify that it is bound to ${account}. Keep this existing server and account configuration anyway?`,
        initialValue: false,
      });
      if (preserve) {
        preservedUnverifiableServer = true;
        break;
      }
    }

    await params.prompter.note(
      `OpenClaw could not validate this Signal setup.\n\n${probe.error ?? "Signal transport probe failed."}`,
      "Signal setup",
    );
    const recovery = await params.prompter.select<"retry" | "account" | "url" | "stop">({
      message: "How should Signal setup continue?",
      options: [
        { value: "retry", label: "Retry this setup" },
        { value: "account", label: "Try another Signal account" },
        { value: "url", label: "Try another Signal server URL" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "retry",
    });
    if (recovery === "stop") {
      throw new WizardCancelledError("Signal setup stopped");
    }
    if (recovery === "account") {
      shouldPromptAccount = true;
      continue;
    }
    if (recovery === "url") {
      transport = await promptExistingSignalTransport({
        cfg,
        prompter: params.prompter,
        initialValue: transport.url,
      });
      shouldPromptAccount = !account;
    }
  }

  await params.prompter.note(
    preservedUnverifiableServer
      ? `Kept unchanged Signal server ${transport.url} for ${account} without server-side account verification.`
      : `Validated ${account} on ${transport.url}.`,
    "Signal server ready",
  );

  return {
    cfg: writeSignalAccountTransport({
      cfg,
      accountId: params.accountId,
      transport,
    }),
  };
}

async function promptSignalAccount(prompter: WizardPrompter) {
  const raw = await prompter.text({
    message: "Signal phone number",
    placeholder: "+15555550123",
    validate: (value) =>
      normalizeSignalAccountInput(value)
        ? undefined
        : "Enter a Signal phone number in international format, for example +15555550123.",
  });
  const account = normalizeSignalAccountInput(raw);
  if (!account) {
    throw new Error("Signal phone number is required.");
  }
  return account;
}

async function promptSignalServerUrl(prompter: WizardPrompter, initialValue: string) {
  return (
    normalizeOptionalString(
      await prompter.text({
        message: "Signal server URL",
        initialValue,
        placeholder: "http://127.0.0.1:8080",
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    ) ?? initialValue
  );
}

async function promptExistingSignalTransport(
  params: ExistingServerPromptParams,
): Promise<SignalExistingTransport> {
  let url = await promptSignalServerUrl(
    params.prompter,
    params.initialValue ?? "http://127.0.0.1:8080",
  );
  while (true) {
    const detection = await detectSignalTransport({ url }).then(
      (transport) => ({ ok: true as const, transport }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!detection.ok) {
      await params.prompter.note(
        `OpenClaw could not detect a working Signal server at ${url}.\nError: ${String(detection.error)}`,
        "Signal server URL",
      );
      const recovery = await params.prompter.select<"retry" | "url" | "stop">({
        message: "How should Signal server setup continue?",
        options: [
          { value: "retry", label: "Retry this Signal server URL" },
          { value: "url", label: "Try another Signal server URL" },
          { value: "stop", label: "Stop Signal setup" },
        ],
        initialValue: "retry",
      });
      if (recovery === "stop") {
        throw new WizardCancelledError("Signal setup stopped");
      }
      if (recovery === "url") {
        url = await promptSignalServerUrl(params.prompter, url);
      }
      continue;
    }

    const transport = detection.transport;
    if (transport.kind === "managed-native") {
      throw new Error("Signal transport detection returned a managed-native transport");
    }
    if (!aliasesManagedSignalEndpoint(params.cfg, transport.url)) {
      return transport;
    }

    await params.prompter.note(
      [
        "That URL is an OpenClaw-managed Signal daemon.",
        "It stops when its account switches away from local signal-cli.",
        "Enter the URL of an independently operated Signal server instead.",
      ].join("\n"),
      "Signal server URL",
    );
    const recovery = await params.prompter.select<"url" | "stop">({
      message: "How should Signal server setup continue?",
      options: [
        { value: "url", label: "Try another Signal server URL" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "url",
    });
    if (recovery === "stop") {
      throw new WizardCancelledError("Signal setup stopped");
    }
    url = await promptSignalServerUrl(params.prompter, url);
  }
}

export async function prepareSignalExistingServerSetup(
  params: SignalPrepareParams,
  resolvedTransport: ResolvedSignalTransport,
) {
  const originalAccount = normalizeSignalAccountInput(
    resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.account,
  );
  const transport = await promptExistingSignalTransport({
    cfg: params.cfg,
    prompter: params.prompter,
    initialValue:
      resolvedTransport.kind === "external-native" || resolvedTransport.kind === "container"
        ? resolvedTransport.baseUrl
        : "http://127.0.0.1:8080",
  });
  return {
    credentialValues: {
      [signalSetupStateKeys.transportKind]: transport.kind,
      [signalSetupStateKeys.serverUrl]: transport.url,
      ...(originalAccount && resolvedTransport.kind === "external-native"
        ? {
            [signalSetupStateKeys.externalReuseAccount]: originalAccount,
            [signalSetupStateKeys.externalReuseTransport]: externalNativeTransportIdentity({
              kind: "external-native",
              url: resolvedTransport.baseUrl,
            }),
          }
        : {}),
    },
  };
}

function externalNativeTransportIdentity(
  transport: Extract<SignalExistingTransport, { kind: "external-native" }>,
): string {
  return `${transport.kind}:\0${normalizeSignalTransportUrl(transport.url)}`;
}

function isUnchangedConfiguredExternalNative(params: {
  credentialValues: Record<string, unknown>;
  account: string;
  transport: SignalExistingTransport;
}): boolean {
  return (
    params.transport.kind === "external-native" &&
    params.credentialValues[signalSetupStateKeys.externalReuseAccount] === params.account &&
    params.credentialValues[signalSetupStateKeys.externalReuseTransport] ===
      externalNativeTransportIdentity(params.transport)
  );
}

function aliasesManagedSignalEndpoint(cfg: OpenClawConfig, candidateUrl: string): boolean {
  const normalizedCandidate = normalizeSignalTransportUrl(candidateUrl);
  const localEndpointAliases = listLocalSignalEndpointAliases();
  return listSignalAccountIds(cfg).some((accountId) => {
    const account = resolveSignalAccount({ cfg, accountId });
    if (!account.configured || account.transport.kind !== "managed-native") {
      return false;
    }
    if (normalizeSignalTransportUrl(account.transport.baseUrl) === normalizedCandidate) {
      return true;
    }
    return isSignalManagedNativeConnectionUrlForBind(
      {
        kind: "managed-native",
        httpHost: account.transport.httpHost,
        httpPort: account.transport.httpPort,
        url: normalizedCandidate,
      },
      { localEndpointAliases },
    );
  });
}

function listLocalSignalEndpointAliases(): ReadonlySet<string> {
  const machineHostname = hostname();
  const aliases = new Set([machineHostname, `${machineHostname}.local`]);
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        aliases.add(entry.address);
      }
    }
  } catch {
    // Restricted runtimes can deny interface enumeration; hostname aliases still protect
    // wildcard-bound managed daemons from being persisted as independently owned.
  }
  return aliases;
}
