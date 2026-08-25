<!-- apps/web/src/components/chat/SideChatPanel.vue -->
<!-- BTW "side chat": a side-channel agent rendered in the right-side panel.
     It keeps the parent's context without creating a sidebar session. Reuses
     ChatPane for the transcript; its panel-open emits are no-ops here, except
     openMedia which is forwarded so tool media still opens the lightbox. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ChatPane from './ChatPane.vue';
import WorkingIndicator from './WorkingIndicator.vue';
import { Icon, PanelHeader, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import { joinDraftSegments } from '@moonshot-ai/app-client/lib';
import type { ChatTurn, OpenMediaRequest } from '../../types';

const props = defineProps<{
  turns: ChatTurn[];
  running: boolean;
  sending: boolean;
  title?: string;
  subtitle?: string;
  /** The parent session the side chat belongs to — the pending-draft lookup
      key (a guarded quote open stashes by it) and the whole-draft
      persistence key. */
  parentSessionId?: string;
  /** Read-and-clear the session's pending side-chat draft (client facade). */
  consumePendingDraft?: (sessionId: string) => string | null;
  /** Whole-draft persistence (client facade): the panel instance is reused
      across session switches (not keyed) and unmounts when the target
      session has no BTW tab, so the draft lives in the session-keyed client
      store — saved on every change, re-loaded on mount / switch. */
  loadDraft?: (sessionId: string) => string;
  saveDraft?: (sessionId: string, text: string) => void;
  /** Post-send cleanup: clear the session's persisted draft ONLY when it
      still equals the snapshot (a draft that moved on mid-flight is the
      user's new content and survives). */
  clearDraftIfUnchanged?: (sessionId: string, snapshot: string) => void;
  /** Resolves false when the prompt provably never left (a pre-submit
      failure) — the draft stays in the box for a retry. */
  onSend: (text: string) => Promise<boolean>;
}>();

const emit = defineEmits<{
  close: [];
  openMedia: [payload: OpenMediaRequest];
}>();

const { t } = useI18n();

const firstUserText = computed(() => {
  const turn = props.turns.find((t) => t.role === 'user');
  return turn?.text?.trim() ?? '';
});

const panelTitle = computed(() => props.title?.trim() || t('sideChat.title'));
const panelSubtitle = computed(() => {
  if (props.subtitle?.trim()) return props.subtitle.trim();
  return firstUserText.value || t('sideChat.subtitle');
});

const draft = ref('');
const inputRef = ref<HTMLTextAreaElement | null>(null);
const bodyRef = ref<HTMLDivElement | null>(null);

const submitting = ref(false);

async function submit(): Promise<void> {
  const raw = draft.value;
  const text = raw.trim();
  if (!text || submitting.value) return;
  // Capture the SOURCE session before the await: the panel may close or be
  // reused on another session while the send is in flight, and
  // props.parentSessionId would then point at the wrong session — the
  // persisted draft must be cleared where the text was sent FROM, never on
  // the session the panel happens to show afterwards.
  const sourceSid = props.parentSessionId;
  submitting.value = true;
  try {
    const sent = await props.onSend(text);
    // Unsent (the failure already toasted) — keep the draft for a retry.
    if (!sent) return;
    // The local cleanup below dies with the component (a mid-flight close or
    // session switch stops the draft watcher), so clear the SOURCE session's
    // persisted draft here — but only when nothing new was typed there
    // since: an advanced snapshot is the user's new content and survives.
    if (sourceSid) props.clearDraftIfUnchanged?.(sourceSid, raw);
    // The box stayed editable while the send was in flight — clear only when
    // nothing new was typed since, never eat in-progress typing.
    if (draft.value !== raw) return;
    draft.value = '';
    void nextTick(() => {
      if (inputRef.value) inputRef.value.style.height = 'auto';
      scrollToBottom();
    });
  } finally {
    submitting.value = false;
  }
}

function scrollToBottom(): void {
  const el = bodyRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

// ChatPane anchors the toggle when collapsing an overlong user message. The
// ConversationPane pin machinery (follow state, transition chasing) doesn't
// exist here; the collapse is instant, so a one-shot correction suffices.
provide('pinScroll', (el: HTMLElement) => {
  const scroller = bodyRef.value;
  if (!scroller) return;
  const top = el.getBoundingClientRect().top;
  requestAnimationFrame(() => {
    scroller.scrollTop += el.getBoundingClientRect().top - top;
  });
});

const scrollKey = computed(() => {
  const t = props.turns;
  if (t.length === 0) return '0';
  const last = t.at(-1)!;
  const thinkingLen = last.thinking?.length ?? 0;
  const toolsLen =
    last.tools?.reduce(
      (n, tool) => n + tool.name.length + (tool.arg?.length ?? 0) + (tool.output?.join('').length ?? 0),
      0,
    ) ?? 0;
  return `${t.length}:${last.text.length}:${thinkingLen}:${toolsLen}`;
});

watch(scrollKey, async () => {
  if (!props.running && !props.sending) return;
  await nextTick();
  scrollToBottom();
});

/** Show a lightweight "waiting for first token" indicator from the moment the
    user sends a prompt until the assistant's first message appears. */
const showLoading = computed(() => {
  if (!props.sending) return false;
  const last = props.turns.at(-1);
  return last?.role === 'user';
});

// IME guard: Enter that only confirms a composition candidate must not send.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !isComposingKeyEvent(e)) {
    e.preventDefault();
    submit();
  }
}

function autosize(): void {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

/** Focus the composer textarea. App calls this after an explicit open
    (shortcut / `/btw`) so typing continues in the side chat without a click;
    deliberately not called when the panel is restored on a session switch. */
function focusInput(): void {
  inputRef.value?.focus();
}

/** Insert text into the side-chat draft WITHOUT sending (selection quote
    actions — 划词, plan B): newline-normalized join (exactly one blank line
    between segments — a quote block already ends with `\n\n`), then focus
    with the caret at the end and re-run autosize. `focus: false` writes
    without stealing focus (the caller's arm-guard owns focusing then). */
function insertDraft(text: string, opts?: { focus?: boolean }): void {
  draft.value = joinDraftSegments(draft.value, text);
  void nextTick(() => {
    const el = inputRef.value;
    if (!el) return;
    if (opts?.focus !== false) el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autosize();
  });
}

defineExpose({ focusInput, insertDraft });

// A guarded side-chat open (selection quote action where the user moved on
// mid-flight) stashes the quote as the session's pending draft instead of
// forcing the panel open — adopt it when the panel next mounts for this
// session. No focus steal: the user opened the panel themselves.
onMounted(() => {
  if (!props.parentSessionId || !props.consumePendingDraft) return;
  const pending = props.consumePendingDraft(props.parentSessionId);
  if (pending !== null) insertDraft(pending, { focus: false });
});

// Whole-draft persistence: load the CURRENT session's draft on mount and on
// every session switch (the instance is reused — without this, session A's
// draft would show in session B's box, or die with the unmount), and save on
// every change. The draft watcher also flushes the reload, but writing the
// same value back is a no-op save. The session's PENDING draft (the
// guarded-open stash above) rides the same load: it is session-keyed too,
// and an instance REUSED across an A→B switch never re-runs onMounted, so B's
// stash would otherwise wait for a real remount. The take clears it, so the
// onMounted adoption stays a once-only fallback (an immediate watcher runs
// before onMounted on a real mount).
watch(
  () => props.parentSessionId,
  (sid) => {
    let loaded = (sid && props.loadDraft?.(sid)) || '';
    const pending = sid && props.consumePendingDraft ? props.consumePendingDraft(sid) : null;
    if (pending !== null) loaded = joinDraftSegments(loaded, pending);
    draft.value = loaded;
    void nextTick(autosize);
  },
  { immediate: true },
);
watch(draft, (text) => {
  if (props.parentSessionId) props.saveDraft?.(props.parentSessionId, text);
});
</script>

<template>
  <div class="sc">
    <PanelHeader
      :title="panelTitle"
      :subtitle="panelSubtitle"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    />
    <div ref="bodyRef" class="sc-body">
      <div v-if="turns.length === 0" class="sc-empty">{{ t('sideChat.empty') }}</div>
      <ChatPane
        v-else
        :turns="turns"
        :approvals="[]"
        :turn-active="running"
        :working="sending || running"
        :turn-files-interactive="false"
        :selection-actions="false"
        @open-media="emit('openMedia', $event)"
      />
      <div v-if="showLoading" class="sc-loading">
        <WorkingIndicator :label="t('conversation.requesting')" />
      </div>
    </div>

    <div class="sc-composer">
      <textarea
        ref="inputRef"
        v-model="draft"
        class="sc-input"
        rows="1"
        :placeholder="t('sideChat.placeholder')"
        @input="autosize"
        @keydown="onKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
      ></textarea>
      <Tooltip :text="t('sideChat.send')">
        <button type="button" class="sc-send" :disabled="!draft.trim()" @click="submit">
          <Icon name="arrow-right" size="sm" />
        </button>
      </Tooltip>
    </div>
  </div>
</template>

<style scoped>
.sc {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg);
}
.sc-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.sc-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--muted);
  font-size: var(--ui-font-size);
}

.sc-composer {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 8px 10px;
  border-top: 0.5px solid var(--color-line);
  background: var(--color-surface-raised);
}
.sc-input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 0.5px solid var(--color-line);
  border-radius: var(--r-sm);
  padding: 7px 9px;
  background: var(--bg);
  color: var(--color-text);
  font: var(--ui-font-size)/1.5 var(--sans);
  outline: none;
  max-height: 160px;
}
.sc-input:focus { border-color: var(--color-accent-bd); }
.sc-send {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--r-sm);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  cursor: pointer;
}
.sc-send:disabled { opacity: 0.4; cursor: default; }
.sc-send:not(:disabled):hover { background: var(--color-accent-hover); }

/* Send → first-token loading indicator (replaces ChatPane's working
   placeholder). */
.sc-loading {
  flex: none;
  padding: 8px 12px 12px;
}

/* The side chat reuses ChatPane, but we don't want its working placeholder
   here — the tab already shows activity via the parent layout. */
.sc-body :deep(.sending-placeholder),
.sc-body :deep(.sending-line) {
  display: none;
}
</style>
