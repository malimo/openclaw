import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { activateSlashCommands, refreshSlashCommands } from "../chat/chat-commands.ts";
import { renderChatAttachmentMenu } from "../chat/components/chat-attachments.ts";
import { renderChatComposer } from "../chat/components/chat-composer.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import type { NewSessionModelControl } from "./model-control.ts";

type NewSessionComposerOptions = {
  attachmentLimits?: { maxBytes: number; maxImageBytes: number };
  agent?: import("../../api/types.ts").GatewayAgentRow;
  agentId: string;
  getCurrentAgentId: () => string;
  attachments: ChatAttachment[];
  canSubmit: boolean;
  context: import("../../app/context.ts").ApplicationContext | undefined;
  getAttachments: () => ChatAttachment[];
  message: string;
  modelControl?: TemplateResult | typeof nothing;
  pendingAttachmentReads: number;
  readSignal: AbortSignal;
  requiresModifier: boolean;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  terminalAction?: {
    canStart: boolean;
    disabledReason?: string;
    onStart: () => void;
  };
  submitting: boolean;
  messageLocked?: boolean;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onPendingReadsChange: (delta: 1 | -1) => void;
  onInput: (message: string) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onRequestUpdate: () => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
};

function renderStartControl(options: NewSessionComposerOptions) {
  const startLabel = options.submitting ? t("newSession.starting") : t("newSession.start");
  if (!options.terminalAction) {
    return html`
      <openclaw-tooltip content=${options.submitDisabledReason ?? t("newSession.start")}>
        <button
          type="button"
          class="chat-send-btn new-session-page__start-submit"
          ?disabled=${!options.canSubmit}
          aria-busy=${String(options.submitting)}
          aria-label=${startLabel}
          @click=${options.onSubmit}
        >
          ${options.submitting ? icons.loader : icons.arrowUp}
        </button>
      </openclaw-tooltip>
    `;
  }
  const terminalLabel = t("newSession.startInTerminal");
  return html`
    <div class="new-session-page__start-split">
      <openclaw-tooltip content=${options.submitDisabledReason ?? t("newSession.start")}>
        <button
          type="button"
          class="chat-send-btn new-session-page__start-submit new-session-page__start-primary"
          ?disabled=${!options.canSubmit}
          aria-busy=${String(options.submitting)}
          aria-label=${startLabel}
          @click=${options.onSubmit}
        >
          ${options.submitting ? icons.loader : icons.arrowUp}
        </button>
      </openclaw-tooltip>
      <openclaw-tooltip content=${options.terminalAction.disabledReason ?? terminalLabel}>
        <wa-dropdown class="new-session-page__start-menu" placement="top-end">
          <button
            slot="trigger"
            type="button"
            class="chat-send-btn new-session-page__start-menu-trigger"
            ?disabled=${!options.terminalAction.canStart}
            aria-label=${terminalLabel}
          >
            ${icons.chevronUp}
          </button>
          <wa-dropdown-item
            value="start-terminal"
            ?disabled=${!options.terminalAction.canStart}
            @click=${() => {
              if (options.terminalAction?.canStart) {
                options.terminalAction.onStart();
              }
            }}
          >
            ${terminalLabel}
          </wa-dropdown-item>
        </wa-dropdown>
      </openclaw-tooltip>
    </div>
  `;
}

/** Draft visibility pill: selecting it clears incognito, re-click returns to normal. */
function renderVisibilityPill(params: {
  mode: Exclude<NewSessionVisibility, "normal">;
  icon: unknown;
  label: string;
  description: string;
  options: NewSessionComposerOptions;
}) {
  const active = params.options.visibility === params.mode;
  const disabled = params.options.submitting || params.options.messageLocked;
  return html`
    <button
      type="button"
      class="new-session-page__visibility ${active ? "new-session-page__visibility--active" : ""}"
      role="switch"
      aria-checked=${String(active)}
      ?disabled=${disabled}
      title=${params.description}
      @click=${() => params.options.onVisibilityChange?.(active ? "normal" : params.mode)}
    >
      <span aria-hidden="true">${params.icon}</span>${params.label}
    </button>
  `;
}

export function renderDraftError(message: string) {
  return html`
    <div class="callout danger new-session-page__error new-session-page__alert" role="alert">
      <span class="new-session-page__alert-icon" aria-hidden="true">${icons.alertTriangle}</span>
      <span class="callout__content new-session-page__alert-message"
        >${formatUiError(message)}</span
      >
    </div>
  `;
}

function renderNewSessionComposer(options: NewSessionComposerOptions) {
  const attachmentProps = {
    attachmentLimits: options.attachmentLimits,
    attachments: options.attachments,
    disabled: options.submitting || options.messageLocked,
    getAttachments: options.getAttachments,
    draft: options.message,
    getDraft: () => options.message,
    onAttachmentsChange: options.onAttachmentsChange,
    onDraftChange: options.onInput,
    onPendingReadsChange: options.onPendingReadsChange,
    onOpenImage: options.onOpenImage,
    readSignal: options.readSignal,
  };
  const context = options.context;
  const client = context?.gateway.snapshot.client ?? null;
  const canCompose = !options.submitting && !options.messageLocked;
  const composerControls = html`
    ${renderChatAttachmentMenu(attachmentProps)}
    ${options.modelControl && options.modelControl !== nothing
      ? html`<div class="chat-composer-model-control">${options.modelControl}</div>`
      : nothing}
    ${options.draftAvailable
      ? renderVisibilityPill({
          mode: "draft",
          icon: icons.pencil,
          label: t("newSession.draft"),
          description: t("newSession.draftDescription"),
          options,
        })
      : nothing}
    ${options.pendingAttachmentReads > 0
      ? html`<span class="sr-only" role="status">${t("newSession.readingAttachment")}</span>`
      : nothing}
  `;
  return renderChatComposer({
    style: "new-session",
    shellClass: "new-session-page__composer",
    textareaClass: "new-session-page__message",
    placeholder: t("newSession.messagePlaceholder"),
    primaryActions: renderStartControl(options),
    commandFilter: (command) => command.executeLocal !== true,
    paneId: "new-session",
    sessionKey: "new-session",
    currentAgentId: options.agentId,
    connected: context ? context.gateway.snapshot.phase === "connected" : true,
    canSend: canCompose,
    canSubmit: options.canSubmit,
    disabledReason: null,
    sending: options.submitting,
    messages: [],
    stream: null,
    queue: [],
    draft: options.message,
    sessions: null,
    assistantName: options.agent?.name ?? options.agentId,
    sendShortcut: options.requiresModifier ? "modifier-enter" : "enter",
    attachments: options.attachments,
    attachmentLimits: options.attachmentLimits,
    getAttachments: options.getAttachments,
    pendingAttachmentReads: options.pendingAttachmentReads,
    getPendingAttachmentReads: () => options.pendingAttachmentReads,
    readSignal: options.readSignal,
    onPendingReadsChange: options.onPendingReadsChange,
    onOpenImage: options.onOpenImage,
    composerControls,
    getDraft: () => options.message,
    onDraftChange: options.onInput,
    onRequestUpdate: options.onRequestUpdate,
    onCompletionOwnerChange: () =>
      activateSlashCommands({ client, agentId: options.getCurrentAgentId() }),
    onSlashIntent: client
      ? () => {
          const agentId = options.agentId;
          return refreshSlashCommands({
            client,
            agentId,
            shouldApply: () => {
              const snapshot = options.context?.gateway.snapshot;
              return (
                snapshot?.phase === "connected" &&
                snapshot.client === client &&
                options.getCurrentAgentId() === agentId
              );
            },
          });
        }
      : undefined,
    onSubmitShortcut: () => {
      if (!options.canSubmit && options.submitDisabledReason === undefined) {
        return false;
      }
      options.onSubmit();
      return true;
    },
    onSend: options.onSubmit,
    onAttachmentsChange: options.onAttachmentsChange,
    statusContent: options.blockedSubmitNotice
      ? html`<div class="new-session-page__blocked-submit" role="status">
          ${options.blockedSubmitNotice}
        </div>`
      : nothing,
  });
}

export function renderNewSessionDraftComposer(options: {
  agent?: import("../../api/types.ts").GatewayAgentRow;
  agentId: string;
  getCurrentAgentId: () => string;
  attachmentDraft: NewSessionAttachmentDraft;
  canSubmit: boolean;
  context: import("../../app/context.ts").ApplicationContext | undefined;
  isCatalogTarget: boolean;
  message: string;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  modelControl: NewSessionModelControl;
  requiresModifier: boolean;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  terminalAction?: {
    canStart: boolean;
    disabledReason?: string;
    onStart: () => void;
  };
  submitting: boolean;
  messageLocked?: boolean;
  onInput: (message: string) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onRequestUpdate: () => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
}) {
  const readSignal = options.attachmentDraft.readSignal;
  return renderNewSessionComposer({
    attachmentLimits: options.context?.gateway.snapshot.hello?.policy?.attachments,
    agent: options.agent,
    agentId: options.agentId,
    getCurrentAgentId: options.getCurrentAgentId,
    attachments: options.attachmentDraft.attachments,
    canSubmit: options.canSubmit,
    context: options.context,
    getAttachments: () => options.attachmentDraft.attachments,
    message: options.message,
    visibility: options.visibility,
    draftAvailable: options.draftAvailable,
    modelControl: options.isCatalogTarget
      ? nothing
      : options.modelControl.render({
          agent: options.agent,
          agentId: options.agentId,
          context: options.context,
          sending: options.submitting,
        }),
    pendingAttachmentReads: options.attachmentDraft.pendingReads,
    readSignal,
    requiresModifier: options.requiresModifier,
    submitDisabledReason: options.submitDisabledReason,
    blockedSubmitNotice: options.blockedSubmitNotice,
    terminalAction: options.terminalAction,
    submitting: options.submitting,
    messageLocked: options.messageLocked,
    onAttachmentsChange: (attachments) => {
      if (!options.submitting && !options.messageLocked) {
        options.attachmentDraft.replace(attachments);
      }
    },
    onPendingReadsChange: (delta) => options.attachmentDraft.updatePending(readSignal, delta),
    onInput: options.onInput,
    onOpenImage: options.onOpenImage,
    onRequestUpdate: options.onRequestUpdate,
    onVisibilityChange: options.onVisibilityChange,
    onSubmit: options.onSubmit,
  });
}
