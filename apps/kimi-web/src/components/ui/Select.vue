<!-- apps/kimi-web/src/components/ui/Select.vue -->
<!-- Design-system §03 Select: the trigger shares Input's sizing/surface/focus,
     and the popup reuses the Menu surface + rows so the open state follows the
     design system instead of the OS-native listbox. Options are data-driven
     (no slot): pass flat options, with `group` set on an option to render a
     group header whenever it differs from the previous option's group. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue';
import Icon from './Icon.vue';

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Group header text — a header row is rendered whenever it differs from the
      previous option's group. */
  group?: string;
}

const props = withDefaults(defineProps<{
  modelValue?: string;
  options?: SelectOption[];
  /** Shown (muted) when no option matches modelValue. */
  placeholder?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  error?: boolean;
  ariaLabel?: string;
}>(), {
  options: () => [],
  placeholder: '',
  size: 'md',
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const uid = useId();
const open = ref(false);
const rootRef = ref<HTMLElement>();
const triggerRef = ref<HTMLButtonElement>();
const popRef = ref<HTMLElement>();
const popStyle = ref<Record<string, string>>({});
const activeIdx = ref(-1);

const selectedOption = computed(() => props.options.find((o) => o.value === props.modelValue));

function optionId(i: number): string {
  return `${uid}-opt-${i}`;
}

// The component may be mounted into a popped-out window (KAP debug panel), so
// DOM objects are resolved from the root element rather than module globals.
function doc(): Document {
  return rootRef.value?.ownerDocument ?? document;
}

function win(): Window {
  return doc().defaultView ?? window;
}

function onDocMouseDown(e: MouseEvent): void {
  if (rootRef.value?.contains(e.target as Node)) return;
  close();
}

function onWinScroll(e: Event): void {
  // Scrolling inside the popup list must not close it.
  if (popRef.value?.contains(e.target as Node)) return;
  close();
}

async function openPop(): Promise<void> {
  if (props.disabled || open.value || props.options.length === 0) return;
  // Fix the popup width and hide it before the first paint so the height
  // measurement below is stable and there's no flash at the wrong spot.
  const rect = triggerRef.value?.getBoundingClientRect();
  popStyle.value = { visibility: 'hidden', minWidth: `${Math.round(rect?.width ?? 0)}px` };
  open.value = true;
  const selected = props.options.findIndex((o) => o.value === props.modelValue && !o.disabled);
  activeIdx.value = selected >= 0 ? selected : firstEnabled();
  doc().addEventListener('mousedown', onDocMouseDown, true);
  win().addEventListener('resize', close);
  win().addEventListener('scroll', onWinScroll, true);
  await nextTick();
  positionPop();
  scrollActiveIntoView();
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  doc().removeEventListener('mousedown', onDocMouseDown, true);
  win().removeEventListener('resize', close);
  win().removeEventListener('scroll', onWinScroll, true);
}

onBeforeUnmount(() => close());

function toggle(): void {
  if (open.value) close();
  else void openPop();
}

function firstEnabled(): number {
  return props.options.findIndex((o) => !o.disabled);
}

function lastEnabled(): number {
  for (let i = props.options.length - 1; i >= 0; i--) {
    if (!props.options[i]?.disabled) return i;
  }
  return -1;
}

function moveActive(delta: number): void {
  const n = props.options.length;
  if (n === 0) return;
  let i = activeIdx.value;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (!props.options[i]?.disabled) break;
  }
  activeIdx.value = i;
  scrollActiveIntoView();
}

function scrollActiveIntoView(): void {
  popRef.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
}

// Anchors the popup to the trigger, flipping above when the viewport bottom
// doesn't fit it (same pattern as the ChatHeader kebab menu).
function positionPop(): void {
  const trigger = triggerRef.value;
  const pop = popRef.value;
  if (!trigger || !pop) return;
  const w = win();
  const r = trigger.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const popH = pop.offsetHeight;
  let top = r.bottom + gap;
  if (top + popH > w.innerHeight - margin && r.top - gap - popH > margin) {
    top = r.top - gap - popH;
  }
  const popW = pop.offsetWidth;
  let left = r.left;
  if (left + popW > w.innerWidth - margin) left = Math.max(margin, w.innerWidth - margin - popW);
  popStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    minWidth: `${Math.round(r.width)}px`,
  };
}

function choose(option: SelectOption): void {
  if (option.disabled) return;
  emit('update:modelValue', option.value);
  close();
  triggerRef.value?.focus();
}

// Focus stays on the trigger while the popup is open (listbox pattern), so all
// open-state keys are handled here.
function onTriggerKeydown(e: KeyboardEvent): void {
  if (!open.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openPop();
    }
    return;
  }
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      // Don't let an enclosing dialog's own Escape handler close it with us.
      e.stopPropagation();
      close();
      break;
    case 'ArrowDown':
      e.preventDefault();
      moveActive(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      moveActive(-1);
      break;
    case 'Home':
      e.preventDefault();
      activeIdx.value = firstEnabled();
      scrollActiveIntoView();
      break;
    case 'End':
      e.preventDefault();
      activeIdx.value = lastEnabled();
      scrollActiveIntoView();
      break;
    case 'Enter':
    case ' ': {
      e.preventDefault();
      const opt = props.options[activeIdx.value];
      if (opt) choose(opt);
      break;
    }
    case 'Tab':
      close();
      break;
  }
}
</script>

<template>
  <div
    ref="rootRef"
    class="ui-select"
    :class="[`ui-select--${size}`, { 'is-open': open, 'has-error': error }]"
  >
    <button
      ref="triggerRef"
      type="button"
      class="ui-select-trigger"
      :disabled="disabled"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-activedescendant="open && activeIdx >= 0 ? optionId(activeIdx) : undefined"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="ui-select-value" :class="{ 'is-placeholder': !selectedOption }">
        {{ selectedOption?.label ?? placeholder }}
      </span>
      <Icon class="ui-select-chev" name="chevron-down" size="sm" />
    </button>

    <!-- Fixed popup, anchored to the trigger. mousedown is preventDefaulted so
         clicking an option doesn't move focus away from the trigger. -->
    <div
      v-if="open"
      ref="popRef"
      class="ui-select-pop"
      :class="`ui-select-pop--${size}`"
      :style="popStyle"
      role="listbox"
      :aria-label="ariaLabel"
      @mousedown.prevent
    >
      <template v-for="(opt, i) in options" :key="opt.value">
        <div
          v-if="opt.group && (i === 0 || options[i - 1]?.group !== opt.group)"
          class="ui-select-group"
        >
          {{ opt.group }}
        </div>
        <div
          :id="optionId(i)"
          class="ui-select-option"
          :class="{
            'is-active': i === activeIdx,
            'is-selected': opt.value === modelValue,
            'is-disabled': opt.disabled,
          }"
          role="option"
          :aria-selected="opt.value === modelValue"
          :aria-disabled="opt.disabled ? true : undefined"
          :title="opt.label"
          @click="choose(opt)"
          @mouseenter="!opt.disabled && (activeIdx = i)"
        >
          <span class="ui-select-option-label">{{ opt.label }}</span>
          <Icon v-if="opt.value === modelValue" class="ui-select-check" name="check" size="sm" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ui-select { position: relative; width: 100%; }

/* Trigger: same sizing / surface / focus as Input. */
.ui-select-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  padding: 0 var(--space-3);
  cursor: pointer;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.ui-select--md .ui-select-trigger { height: 38px; }
.ui-select--sm .ui-select-trigger { height: 32px; font-size: var(--text-sm); }
.ui-select-trigger:hover:not(:disabled) { border-color: var(--color-line-strong); }
.ui-select-trigger:focus-visible {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: var(--p-focus-ring);
}
.ui-select.is-open .ui-select-trigger {
  border-color: var(--color-accent);
  box-shadow: var(--p-focus-ring);
}
.ui-select-trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-select.has-error .ui-select-trigger { border-color: var(--color-danger); }
.ui-select.has-error .ui-select-trigger:focus-visible { box-shadow: 0 0 0 3px var(--color-danger-soft); }

.ui-select-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.ui-select-value.is-placeholder { color: var(--color-text-faint); }
.ui-select-chev {
  flex: none;
  color: var(--color-text-muted);
  transition: transform var(--duration-base) var(--ease-out);
}
.ui-select.is-open .ui-select-chev { transform: rotate(180deg); }

/* Popup: same surface as Menu. */
.ui-select-pop {
  position: fixed;
  z-index: var(--z-dropdown);
  min-width: 140px;
  max-width: 320px;
  max-height: 260px;
  overflow-y: auto;
  padding: var(--space-1);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
}

/* Options: same row styling as MenuItem. */
.ui-select-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  cursor: pointer;
  user-select: none;
  transition: background var(--duration-base), color var(--duration-base);
}
.ui-select-pop--sm .ui-select-option { font-size: var(--text-sm); }
.ui-select-option.is-active { background: var(--color-surface-sunken); }
.ui-select-option.is-disabled { opacity: 0.5; cursor: not-allowed; }
.ui-select-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-select-check { flex: none; color: var(--color-accent); }

.ui-select-group {
  padding: var(--space-1) 10px 2px;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-faint);
  user-select: none;
}
</style>
