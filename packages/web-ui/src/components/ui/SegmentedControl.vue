<!-- apps/kimi-web/src/components/ui/SegmentedControl.vue -->
<!-- Design-system §03 SegmentedControl: 2-5 mutually exclusive options. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string; icon?: string; swatch?: string }[];
  size?: 'xs' | 'sm' | 'md';
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

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
  const index = props.options.findIndex((option) => option.value === props.modelValue);
  const item = itemRefs.value[index];
  if (!item) return;
  indicatorStyle.value = {
    width: `${item.offsetWidth}px`,
    height: `${item.offsetHeight}px`,
    transform: `translate(${item.offsetLeft}px, ${item.offsetTop}px)`,
  };
  indicatorReady.value = true;
}

watch(() => [props.modelValue, props.options.length], updateIndicator, { immediate: true });

onMounted(() => {
  resizeObserver = new ResizeObserver(() => updateIndicator());
  if (root.value) resizeObserver.observe(root.value);
  for (const item of itemRefs.value) resizeObserver.observe(item);
  updateIndicator();
});

onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <div ref="root" class="ui-seg" :class="`ui-seg--${size ?? 'md'}`" role="tablist">
    <span
      class="ui-seg__indicator"
      :class="{ 'is-ready': indicatorReady }"
      :style="indicatorStyle"
      aria-hidden="true"
    />
    <button
      v-for="(opt, index) in options"
      :key="opt.value"
      :ref="(el) => setItemRef(el, index)"
      class="ui-seg__item"
      :class="{ 'is-on': opt.value === modelValue }"
      type="button"
      role="tab"
      :aria-selected="opt.value === modelValue"
      @click="emit('update:modelValue', opt.value)"
    >
      <Icon v-if="opt.icon" class="ui-seg__icon" :name="opt.icon" size="sm" />
      <span v-if="opt.swatch" class="ui-seg__swatch" :style="{ backgroundColor: opt.swatch }" />
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.ui-seg {
  position: relative;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--color-surface-sunken);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
}
.ui-seg__indicator {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 0;
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  /* Light-mode lifeline: the raised pill on the sunken track is only a 4%
     lightness step and shadow-xs is invisible at this size — give the pill a
     real shadow (iOS recipe). No border: the indicator's edge stays clean,
     separation comes from the shadow. */
  box-shadow: var(--shadow-sm);
  opacity: 0;
  pointer-events: none;
  transition: transform var(--duration-base) var(--ease-out),
    width var(--duration-base) var(--ease-out),
    height var(--duration-base) var(--ease-out),
    opacity var(--duration-fast) var(--ease-out);
}
.ui-seg__indicator.is-ready { opacity: 1; }
.ui-seg__item {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  cursor: pointer;
  line-height: 1;
  /* A segmented control sizes to its labels — never wrap them (a squeezed
     control in a settings row would otherwise grow two-line items). */
  white-space: nowrap;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.ui-seg__swatch {
  width: 7px;
  height: 7px;
  border: 0.5px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 50%;
  flex: none;
}
.ui-seg__icon { flex: none; }
.ui-seg--md .ui-seg__item { padding: 5px var(--space-3); font-size: var(--text-sm); }
.ui-seg--sm .ui-seg__item { height: 24px; padding: 0 var(--space-2); font-size: var(--text-sm); }
/* xs — dense menus (e.g. the composer model dropdown): 20px items, 12px labels. */
.ui-seg--xs .ui-seg__item { height: 20px; padding: 0 var(--space-2); font-size: var(--text-xs); }
.ui-seg__item:hover:not(.is-on) { color: var(--color-text); }
.ui-seg__item.is-on { color: var(--color-text); }
.ui-seg__item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
</style>
