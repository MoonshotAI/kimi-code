<!-- apps/kimi-web/src/components/chat/ThinkingPanel.vue -->
<!-- Full thinking text in the right-side panel (App's shared preview slot —
     opening this replaces a file preview and vice versa). Content is reactive:
     while the block is still streaming the text keeps growing, and the body
     follows the bottom as long as the user hasn't scrolled up. -->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import PanelHeader from '../ui/PanelHeader.vue';

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
    <PanelHeader
      :title="t('common.preview')"
      :subtitle="subtitle ?? t('thinking.panelTitle')"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    />
    <pre ref="bodyEl" class="tp-body">{{ text }}</pre>
  </div>
</template>

<style scoped>
.tp {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}

.tp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 12px 14px;
  font: var(--text-base)/var(--leading-relaxed) var(--font-mono);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
