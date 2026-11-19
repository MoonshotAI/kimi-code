<script setup lang="ts">
import { ref, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import BrandLogo from '../onboarding/BrandLogo.vue';
import type { DockIconChoice } from '../../lib/dockIconChoice';

const props = defineProps<{ modelValue: DockIconChoice }>();
const emit = defineEmits<{ 'update:modelValue': [value: DockIconChoice] }>();

const { t } = useI18n();

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

const options: ReadonlyArray<{ value: DockIconChoice; labelKey: string }> = [
  { value: 'light', labelKey: 'settings.appIconDefault' },
  { value: 'dark', labelKey: 'settings.appIconBlack' },
];

const itemRefs = ref<HTMLElement[]>([]);

function setItemRef(el: Element | ComponentPublicInstance | null, index: number): void {
  if (el instanceof HTMLElement) itemRefs.value[index] = el;
}
</script>

<template>
  <div class="dock-icon-picker" role="radiogroup" :aria-label="t('settings.appIcon')" @keydown="onGroupKeydown">
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
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
}
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
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.dip-item:hover:not(.is-on) { color: var(--color-text); }
.dip-item.is-on {
  color: var(--color-text);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
}
.dip-item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.dip-label {
  font-size: var(--text-2xs);
  font-weight: var(--weight-caption);
  line-height: var(--leading-tight);
}
.dip-tile {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
}
.dip-item :deep(.brand-logo) {
  border: 1px solid color-mix(in srgb, var(--color-line) 60%, transparent);
  border-radius: 22.5%;
  box-shadow: var(--shadow-sm);
}
</style>
