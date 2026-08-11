import type { SystemAgentChatQuestion } from "../../packages/gateway-protocol/src/index.js";
import type { WizardStep } from "../wizard/session.js";
import { classifySystemAgentApprovalText } from "./operator-approval.js";

function formatWizardOptions(step: WizardStep): string[] {
  return (step.options ?? []).map((option, index) => {
    const hint = option.hint ? ` — ${option.hint}` : "";
    return `${index + 1}. ${option.label}${hint}`;
  });
}

export function wizardStepChatQuestion(
  step: WizardStep | null,
): SystemAgentChatQuestion | undefined {
  if (!step) {
    return undefined;
  }
  if (step.type === "confirm") {
    const yesRecommended = step.initialValue !== false;
    return {
      id: step.id,
      header: step.title ?? "Confirm",
      question: step.message ?? "Continue?",
      options: [
        { label: "Yes", reply: "yes", ...(yesRecommended ? { recommended: true } : {}) },
        { label: "No", reply: "no", ...(!yesRecommended ? { recommended: true } : {}) },
      ],
    };
  }
  if (step.type !== "select") {
    return undefined;
  }
  const options = step.options ?? [];
  if (options.length < 2 || options.length > 4) {
    return undefined;
  }
  return {
    id: step.id,
    header: step.title ?? "Choose one",
    question: step.message ?? "Choose one.",
    options: options.map((option) => {
      const mapped: SystemAgentChatQuestion["options"][number] = { label: option.label };
      if (option.hint) {
        mapped.description = option.hint;
      }
      if (step.initialValue !== undefined && option.value === step.initialValue) {
        mapped.recommended = true;
      }
      return mapped;
    }),
  };
}

export function renderWizardStep(step: WizardStep): string {
  const lines: string[] = [];
  if (step.title) {
    lines.push(`**${step.title}**`);
  }
  if (step.message) {
    lines.push(step.message);
  }
  switch (step.type) {
    case "select":
      lines.push(...formatWizardOptions(step), "Reply with a number.");
      break;
    case "multiselect":
      lines.push(...formatWizardOptions(step), "Reply with numbers (e.g. 1,3) or `none`.");
      break;
    case "confirm":
      lines.push("Reply yes or no.");
      break;
    case "text":
      if (step.placeholder) {
        lines.push(`(e.g. ${step.placeholder})`);
      }
      lines.push("Type your answer.");
      break;
    case "qr":
      lines.push("Scan the QR code and approve the device. Setup continues automatically.");
      break;
    default:
      break;
  }
  return lines.filter(Boolean).join("\n");
}

export function parseWizardAnswer(step: WizardStep, text: string): { value: unknown } | null {
  const trimmed = text.trim();
  if (step.type === "confirm") {
    const intent = classifySystemAgentApprovalText(trimmed);
    return intent === "approve" ? { value: true } : intent === "decline" ? { value: false } : null;
  }
  if (step.type === "text") {
    return { value: trimmed };
  }
  const options = step.options ?? [];
  const matchOption = (token: string) => {
    if (/^\d+$/.test(token)) {
      const index = Number(token);
      if (Number.isSafeInteger(index) && index >= 1 && index <= options.length) {
        return options[index - 1];
      }
    }
    const lower = token.toLowerCase();
    return options.find(
      (option) =>
        option.label.toLowerCase() === lower ||
        (typeof option.value === "string" && option.value.toLowerCase() === lower),
    );
  };
  if (step.type === "select") {
    const option = matchOption(trimmed);
    return option ? { value: option.value } : null;
  }
  if (step.type === "multiselect") {
    if (/^none$/i.test(trimmed)) {
      return { value: [] };
    }
    const values: unknown[] = [];
    for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
      const option = matchOption(token);
      if (!option) {
        return null;
      }
      values.push(option.value);
    }
    return { value: values };
  }
  return { value: step.type === "action" ? true : undefined };
}

export function formatStructuredWizardAnswerForHistory(step: WizardStep, value: unknown): string {
  if (step.sensitive === true) {
    return "<redacted secret>";
  }
  if (step.type === "text") {
    return ["string", "number", "boolean", "bigint"].includes(typeof value)
      ? String(value)
      : "<wizard answer>";
  }
  if (step.type === "confirm") {
    return typeof value === "boolean" ? (value ? "Yes" : "No") : "<wizard answer>";
  }
  if (step.type === "select") {
    return (
      step.options?.find((option) => Object.is(option.value, value))?.label ?? "<wizard answer>"
    );
  }
  if (step.type === "multiselect") {
    if (!Array.isArray(value)) {
      return "<wizard answer>";
    }
    if (value.length === 0) {
      return "None";
    }
    const labels = value.map(
      (entry) => step.options?.find((option) => Object.is(option.value, entry))?.label,
    );
    return labels.every((label): label is string => label !== undefined)
      ? labels.join(", ")
      : "<wizard answer>";
  }
  return "Continue";
}
