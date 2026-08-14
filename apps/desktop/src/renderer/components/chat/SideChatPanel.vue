<!-- apps/web/src/components/chat/SideChatPanel.vue -->
<!-- BTW "side chat": a side-channel agent rendered in the right-side panel.
     It keeps the parent's context without creating a sidebar session. Reuses
     ChatPane for the transcript; its panel-open emits are no-ops here, except
     openMedia which is forwarded so tool media still opens the lightbox. -->
<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ChatPane from './ChatPane.vue';
import WorkingIndicator from './WorkingIndicator.vue';
import { Icon, PanelHeader, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import type { ChatTurn, OpenMediaRequest } from '../../types';

const props = defineProps<{
  turns: ChatTurn[];
  running: boolean;
  sending: boolean;
  title?: string;
  subtitle?: string;
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
  submitting.value = true;
  try {
    const sent = await props.onSend(text);
    // Unsent (the failure already toasted) — keep the draft for a retry.
    if (!sent) return;
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
