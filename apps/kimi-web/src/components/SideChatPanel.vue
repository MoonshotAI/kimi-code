<!-- apps/kimi-web/src/components/SideChatPanel.vue -->
<!-- BTW "side chat": a side-channel agent rendered in the right-side panel.
     It keeps the parent's context without creating a sidebar session. Reuses
     ChatPane for the transcript; its panel-open emits are no-ops here. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ChatPane from './ChatPane.vue';
import MoonSpinner from './MoonSpinner.vue';
import type { ChatTurn } from '../types';

const props = defineProps<{
  turns: ChatTurn[];
  running: boolean;
  sending: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
  close: [];
}>();

const { t } = useI18n();

const draft = ref('');
const inputRef = ref<HTMLTextAreaElement | null>(null);
const bodyRef = ref<HTMLDivElement | null>(null);

function submit(): void {
  const text = draft.value.trim();
  if (!text) return;
  emit('send', text);
  draft.value = '';
  void nextTick(() => {
    if (inputRef.value) inputRef.value.style.height = 'auto';
    scrollToBottom();
  });
}

function scrollToBottom(): void {
  const el = bodyRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

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

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
    <div ref="bodyRef" class="sc-body">
      <div v-if="turns.length === 0" class="sc-empty">{{ t('sideChat.empty') }}</div>
      <ChatPane
        v-else
        :turns="turns"
        :approvals="[]"
        :running="running"
        :sending="sending"
        bubble
      />
      <div v-if="showLoading" class="sc-loading" aria-hidden="true">
        <MoonSpinner />
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
      ></textarea>
      <button type="button" class="sc-send" :disabled="!draft.trim()" :title="t('sideChat.send')" @click="submit">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8h10"/><path d="M8 4l4 4-4 4"/></svg>
      </button>
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
  border-top: 1px solid var(--line);
  background: var(--panel);
}
.sc-input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 1px solid var(--line);
  border-radius: var(--r-sm, 8px);
  padding: 7px 9px;
  background: var(--bg);
  color: var(--ink);
  font: var(--ui-font-size)/1.5 var(--sans);
  outline: none;
  max-height: 160px;
}
.sc-input:focus { border-color: var(--bd); }
.sc-send {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--r-sm, 8px);
  background: var(--blue);
  color: #fff;
  cursor: pointer;
}
.sc-send:disabled { opacity: 0.4; cursor: default; }
.sc-send:not(:disabled):hover { background: var(--blue2); }

/* Send → first-token loading indicator (replaces ChatPane's working moon). */
.sc-loading {
  flex: none;
  padding: 8px 12px 12px;
}

/* The side chat reuses ChatPane, but we don't want its working moon/spinner
   placeholder here — the tab already shows activity via the parent layout. */
.sc-body :deep(.sending-placeholder),
.sc-body :deep(.sending-line) {
  display: none;
}
</style>
