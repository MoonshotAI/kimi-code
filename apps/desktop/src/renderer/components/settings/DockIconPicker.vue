<!-- macOS Dock icon appearance picker: tile options in a radiogroup (desktop-only). -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import BrandLogo from '../onboarding/BrandLogo.vue';
import type { DockIconChoice } from '../../lib/dockIconChoice';

const props = defineProps<{ modelValue: DockIconChoice }>();
const emit = defineEmits<{ 'update:modelValue': [value: DockIconChoice] }>();

const { t } = useI18n();

// WAI-ARIA radio-group keyboard model (roving tabindex; arrows wrap).
function onGroupKeydown(event: KeyboardEvent): void {
  const index = options.findIndex((option) => option.value === props.modelValue);
  let next: number;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = options.length - 1;
  else return;
  event.preventDefault();
  const target = options[next];
  if (!target || next === index) return;
  emit('update:modelValue', target.value);
  itemRefs.value[next]?.focus();
}

// Each tile previews the BrandLogo variant the choice itself selects.
const options: ReadonlyArray<{ value: DockIconChoice; labelKey: string }> = [
  { value: 'light', labelKey: 'settings.appIconDefault' },
  { value: 'dark', labelKey: 'settings.appIconBlack' },
];

// Sliding selection indicator (SegmentedControl-style measured pill).
const root = ref<HTMLElement | null>(null);
const itemRefs = ref<HTMLElement[]>([]);
const indicatorReady = ref(false);
const indicatorStyle = ref<Record<string, string>>({});
let resizeObserver: ResizeObserver | null = null;

function setItemRef(el: Element | ComponentPublicInstance | null, index: number): void {
  if (el instanceof HTMLElement) itemRefs.value[index] = el;
}

async function updateIndicator(): Promise<void> {
  await nextTick();
  const index = options.findIndex((option) => option.value === props.modelValue);
  const item = itemRefs.value[index];
  if (!item) return;
  indicatorStyle.value = {
    width: `${item.offsetWidth}px`,
    height: `${item.offsetHeight}px`,
    transform: `translate(${item.offsetLeft}px, ${item.offsetTop}px)`,
  };
  indicatorReady.value = true;
}

watch(() => props.modelValue, updateIndicator, { immediate: true });

onMounted(() => {
  resizeObserver = new ResizeObserver(() => updateIndicator());
  if (root.value) resizeObserver.observe(root.value);
  for (const item of itemRefs.value) resizeObserver.observe(item);
  updateIndicator();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});
</script>

<template>
  <div ref="root" class="dock-icon-picker" role="radiogroup" :aria-label="t('settings.appIcon')" @keydown="onGroupKeydown">
    <span
      class="dip-indicator"
      :class="{ 'is-ready': indicatorReady }"
      :style="indicatorStyle"
      aria-hidden="true"
    />
    <button
      v-for="(opt, index) in options"
      :key="opt.value"
      :ref="(el) => setItemRef(el, index)"
      class="dip-item"
      :class="{ 'is-on': opt.value === modelValue }"
      type="button"
      role="radio"
      :aria-checked="opt.value === modelValue"
      :aria-label="t(opt.labelKey)"
      :tabindex="opt.value === modelValue ? 0 : -1"
      @click="emit('update:modelValue', opt.value)"
    >
      <span class="dip-tile" aria-hidden="true">
        <BrandLogo :size="31" :variant="opt.value" />
      </span>
      <span class="dip-label">{{ t(opt.labelKey) }}</span>
    </button>
  </div>
</template>

<style scoped>
.dock-icon-picker {
  position: relative;
  display: inline-flex;
  gap: var(--space-05);
  padding: var(--space-05);
  background: var(--color-surface-sunken);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
}
.dip-indicator {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 0;
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  opacity: 0;
  pointer-events: none;
  transition: transform var(--duration-base) var(--ease-out),
    width var(--duration-base) var(--ease-out),
    height var(--duration-base) var(--ease-out),
    opacity var(--duration-fast) var(--ease-out);
}
.dip-indicator.is-ready { opacity: 1; }
.dip-item {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  min-width: 64px;
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out);
}
.dip-item:hover:not(.is-on) { color: var(--color-text); }
.dip-item.is-on { color: var(--color-text); }
.dip-item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.dip-label {
  font-size: var(--text-2xs);
  font-weight: var(--weight-caption);
  line-height: var(--leading-tight);
}
/* 0.5px hairline ring per tile = two nested squircle clips (32px line-colour
   wrapper + 31px tile; superellipse n=4.5, the .icns corner shape). The tile's
   text-colour wash keeps both white and black tiles readable on any surface. */
.dip-tile {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  background: var(--color-line);
  clip-path: path("M 32 16 C 32 0.7576 31.2424 0 16 0 C 0.7576 0 0 0.7576 0 16 C 0 31.2424 0.7576 32 16 32 C 31.2424 32 32 31.2424 32 16 Z");
}
.dip-item :deep(.brand-logo) {
  border: none;
  border-radius: 0;
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  clip-path: path("M 31 15.5 C 31 0.7339 30.2661 0 15.5 0 C 0.7339 0 0 0.7339 0 15.5 C 0 30.2661 0.7339 31 15.5 31 C 30.2661 31 31 30.2661 31 15.5 Z");
}
</style>
