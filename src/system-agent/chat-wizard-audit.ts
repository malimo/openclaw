import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ChatWizardHostDependencies } from "./chat-wizard-dependencies.js";

type SetupKind = "channel" | "skills" | "search" | "gateway";

const log = createSubsystemLogger("system-agent/chat-wizard-host");

export async function auditChatWizardSetup(
  kind: SetupKind,
  label: string,
  appendAuditEntry?: ChatWizardHostDependencies["appendAuditEntry"],
): Promise<void> {
  const entry =
    kind === "channel"
      ? {
          operation: "channels.setup",
          summary: `Configured channel ${label} via chat setup`,
          details: { channel: label },
        }
      : kind === "skills"
        ? {
            operation: "skills.setup",
            summary: "Completed skills dependency setup via chat",
            details: { capability: "skills" },
          }
        : kind === "search"
          ? {
              operation: "search.setup",
              summary: "Configured web search via chat setup",
              details: { capability: "web-search" },
            }
          : {
              operation: "gateway.setup",
              summary: "Configured Gateway via chat setup",
              details: { capability: "gateway" },
            };
  try {
    const append = appendAuditEntry ?? (await import("./audit.js")).appendSystemAgentAuditEntry;
    await append(entry);
  } catch (error) {
    log.warn(`${kind} setup completed without audit entry: ${formatErrorMessage(error)}`);
  }
}
