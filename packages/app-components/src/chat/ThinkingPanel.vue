<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  text: string | null;
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
    <pre ref="bodyEl" class="tp-body">{{ text ?? t('panel.compactionUnavailable') }}</pre>
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
  padding-bottom: max(12px, var(--pfc-host-h, 0px));
  font: var(--text-base)/var(--leading-relaxed) var(--font-ui);
  font-weight: 400;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
