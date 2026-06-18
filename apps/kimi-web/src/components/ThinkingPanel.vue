<!-- apps/kimi-web/src/components/ThinkingPanel.vue -->
<!-- Full thinking text in the right-side panel (App's shared preview slot —
     opening this replaces a file preview and vice versa). Content is reactive:
     while the block is still streaming the text keeps growing, and the body
     follows the bottom as long as the user hasn't scrolled up. -->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  text: string;
  /** Header label override — defaults to the thinking panel title. Lets the
      panel double as the compaction-summary viewer. */
  subtitle?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();

const bodyEl = ref<HTMLElement | null>(null);
watch(
  () => props.text,
  () => {
    const el = bodyEl.value;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom) return;
    void nextTick(() => {
      if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="tp">
    <div class="tp-header">
      <span class="tp-title">{{ t('common.preview') }}</span>
      <span class="tp-sub">{{ subtitle ?? t('thinking.panelTitle') }}</span>
      <button type="button" class="tp-close" :title="t('thinking.close')" :aria-label="t('thinking.close')" @click="emit('close')">
        <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
      </button>
    </div>
    <pre ref="bodyEl" class="tp-body">{{ text }}</pre>
  </div>
</template>

<style scoped>
.tp {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg);
}

/* Header height matches the conversation header (32px terminal / 40px modern
   via --panel-head-h) so the hairline reads as one continuous line. */
.tp-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--panel-head-h, 32px);
  padding: 0 6px 0 12px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.tp-title {
  flex: none;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--ink);
}
/* What is being previewed — supplementary, like the file path next door. */
.tp-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
}
.tp-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
}
.tp-close:hover {
  background: var(--hover);
  color: var(--ink);
}
.tp-close:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}

.tp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 12px 14px;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  line-height: 1.7;
  color: var(--dim);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
