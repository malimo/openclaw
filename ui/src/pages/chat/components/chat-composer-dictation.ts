import { ComposerDictationController, insertComposerDictation } from "../composer-dictation.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { commitComposerDraft } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function syncChatComposerDictation(params: {
  enabled: boolean;
  onVoiceTap: () => void;
  props: ChatComposerProps;
  requestUpdate: () => void;
  state: ChatComposerState;
  visibleDraft: string;
}): ComposerDictationController | undefined {
  const { enabled, onVoiceTap, props, requestUpdate, state, visibleDraft } = params;
  if (!enabled) {
    state.dictation?.dispose();
    state.dictation = null;
    state.dictationSelection = null;
    return undefined;
  }

  const options = {
    client: props.gatewayClient ?? null,
    connected: props.connected,
    enabled: true,
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit: (transcript: string) => {
      const target = state.composerTextarea;
      const selection = state.dictationSelection ?? {
        start: target?.selectionStart ?? visibleDraft.length,
        end: target?.selectionEnd ?? visibleDraft.length,
      };
      const currentDraft = target?.value ?? props.getDraft?.() ?? props.draft;
      const insertion = insertComposerDictation(
        currentDraft,
        transcript,
        selection.start,
        selection.end,
      );
      if (target) {
        target.value = insertion.value;
        adjustTextareaHeight(target);
      }
      commitComposerDraft(props, insertion.value);
      state.dictationSelection = null;
      requestUpdate();
      queueMicrotask(() => {
        const textarea = state.composerTextarea;
        if (!textarea) {
          return;
        }
        textarea.focus({ preventScroll: true });
        textarea.selectionStart = insertion.caret;
        textarea.selectionEnd = insertion.caret;
      });
    },
    onError: (message: string) => props.onDictationError?.(message),
    onStateChange: requestUpdate,
    // With an initial empty composer, this button retains the existing
    // send-after-typing behavior until the host rerenders the primary actions.
    // Once a draft is rendered, the separate voice control starts Talk directly.
    onTap:
      visibleDraft.trim() || props.attachments?.length
        ? () => props.onToggleRealtimeTalk?.()
        : onVoiceTap,
  };
  state.dictation ??= new ComposerDictationController(options);
  state.dictation.update(options);
  return state.dictation;
}
