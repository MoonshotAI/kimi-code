<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { FONT_FOLLOWS, useFontPrefs, type FontTarget } from '@moonshot-ai/app-core';
import { Icon } from '@moonshot-ai/app-ui';
import { FONT_HINT_KEYS, FONT_TITLE_KEYS, useFontFamilyLabel } from './fontSettingsLabels';

const props = defineProps<{ target: FontTarget }>();
const emit = defineEmits<{ open: [target: FontTarget, origin: HTMLElement] }>();

const { t } = useI18n();
const { fontPrefs } = useFontPrefs();
const displayFamily = useFontFamilyLabel();

const prefs = computed(() => fontPrefs.value[props.target]);
const followLabel = computed(() =>
  t(FONT_FOLLOWS[props.target] === 'code' ? 'settings.fontFollowCode' : 'settings.fontFollowUi'),
);

const rowRef = ref<HTMLButtonElement>();
const summaryRef = ref<HTMLElement>();
const summaryWidth = ref(0);
let summaryObserver: ResizeObserver | undefined;
let measureContext: CanvasRenderingContext2D | null | undefined;

function summaryTextWidth(text: string, el: HTMLElement): number {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
  }
  if (measureContext === null) return 0;
  const style = getComputedStyle(el);
  measureContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return measureContext.measureText(text).width;
}

const summaryText = computed(() => {
  const suffix = prefs.value.size !== null ? ` · ${prefs.value.size}px` : '';
  const mode = prefs.value.mode;
  if (mode === 'same') return followLabel.value + suffix;
  const names = prefs.value.families.map(displayFamily);
  if (mode !== 'custom' || names.length === 0) {
    return t(mode === 'kimi' ? 'settings.fontKimiDefault' : 'settings.fontSystemDefault') + suffix;
  }
  const width = summaryWidth.value;
  const el = summaryRef.value;
  if (names.length <= 1 || width <= 0 || el === undefined) return names.join(', ') + suffix;
  for (let shown = names.length; shown >= 1; shown--) {
    const hidden = names.length - shown;
    const text = names.slice(0, shown).join(', ') + (hidden > 0 ? ` +${hidden}` : '') + suffix;
    if (summaryTextWidth(text, el) <= width) return text;
  }
  return `+${names.length}${suffix}`;
});

onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !summaryRef.value) return;
  summaryObserver = new ResizeObserver((entries) => {
    summaryWidth.value = entries[0]?.contentRect.width ?? 0;
  });
  summaryObserver.observe(summaryRef.value);
});
onUnmounted(() => summaryObserver?.disconnect());

function onClick(): void {
  if (rowRef.value) emit('open', props.target, rowRef.value);
}
</script>

<template>
  <button ref="rowRef" type="button" class="fs-row" :data-settings-subpage-origin="target" @click="onClick">
    <span class="fs-label">
      {{ t(FONT_TITLE_KEYS[target]) }}
      <span class="fs-hint">{{ t(FONT_HINT_KEYS[target]) }}</span>
    </span>
    <span ref="summaryRef" class="fs-summary">
      <span class="fs-summary-fonts">{{ summaryText }}</span>
    </span>
    <span class="fs-chev"><Icon name="chevron-right" size="sm" /></span>
  </button>
</template>

<style scoped>
.fs-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  min-height: 52px;
  padding: var(--space-4);
  border: none;
  border-top: 0.5px solid var(--color-line);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.fs-row:first-child { border-top: none; }
.fs-row:hover { background: var(--color-hover); }
.fs-row:focus-visible {
  outline: none;
  box-shadow: inset var(--p-focus-ring);
}
.fs-label {
  display: flex;
  flex-direction: column;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  color: var(--color-text);
}
.fs-hint {
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  line-height: var(--leading-tight);
  color: var(--color-text-faint);
}
.fs-summary {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  min-width: 0;
  text-align: right;
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--color-text-muted);
}
.fs-summary-fonts {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
}
.fs-chev {
  display: inline-flex;
  flex: none;
  color: var(--color-text-faint);
}
</style>
