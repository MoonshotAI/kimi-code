<!-- Design-system §03 Select: custom trigger + listbox, with the selected
     option centred in the scrollable menu when it opens. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useAttrs } from 'vue';
import Icon from './Icon.vue';

defineOptions({ inheritAttrs: false });

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
  /** Optional leading icon (image URL), shown in the trigger and the option row. */
  icon?: string;
};

const props = withDefaults(defineProps<{
  modelValue?: string | number;
  options: SelectOption[];
  placeholder?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  error?: boolean;
}>(), {
  placeholder: '',
  size: 'md',
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const attrs = useAttrs();
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const optionRefs = ref<Array<HTMLElement | null>>([]);
const open = ref(false);
const activeIndex = ref(-1);
const listboxId = `ui-select-${Math.random().toString(36).slice(2, 9)}`;

const selectedIndex = computed(() =>
  props.options.findIndex((option) => String(option.value) === String(props.modelValue ?? '')),
);
const selectedOption = computed(() => props.options[selectedIndex.value]);
const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder);

function setOptionRef(el: unknown, index: number): void {
  optionRefs.value[index] = el instanceof HTMLElement ? el : null;
}

function centerActiveOption(): void {
  const list = listRef.value;
  const option = optionRefs.value[activeIndex.value];
  if (!list || !option) return;
  list.scrollTop = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2;
}

function openMenu(): void {
  if (props.disabled || open.value) return;
  open.value = true;
  activeIndex.value = selectedIndex.value >= 0
    ? selectedIndex.value
    : props.options.findIndex((option) => !option.disabled);
  void nextTick(centerActiveOption);
}

function closeMenu({ restoreFocus = false } = {}): void {
  if (!open.value) return;
  open.value = false;
  if (restoreFocus) void nextTick(() => triggerRef.value?.focus());
}

function toggleMenu(): void {
  if (open.value) closeMenu();
  else openMenu();
}

function selectOption(option: SelectOption): void {
  if (option.disabled) return;
  if (String(option.value) !== String(props.modelValue ?? '')) {
    emit('update:modelValue', option.value);
  }
  closeMenu({ restoreFocus: true });
}

function moveActive(delta: 1 | -1): void {
  if (!open.value) openMenu();
  if (props.options.length === 0) return;
  let index = activeIndex.value;
  for (let step = 0; step < props.options.length; step += 1) {
    index = (index + delta + props.options.length) % props.options.length;
    if (!props.options[index]?.disabled) {
      activeIndex.value = index;
      void nextTick(centerActiveOption);
      return;
    }
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveActive(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(-1);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (!open.value) openMenu();
    else {
      const option = props.options[activeIndex.value];
      if (option) selectOption(option);
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const indexes = props.options
      .map((option, index) => option.disabled ? -1 : index)
      .filter((index) => index >= 0);
    activeIndex.value = event.key === 'Home' ? (indexes[0] ?? -1) : (indexes.at(-1) ?? -1);
    void nextTick(centerActiveOption);
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!rootRef.value?.contains(event.target as Node)) closeMenu();
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerDown));
</script>

<template>
  <div
    ref="rootRef"
    class="ui-select"
    :class="[`ui-select--${size}`, { 'has-error': error, 'is-open': open, 'is-disabled': disabled }]"
  >
    <button
      ref="triggerRef"
      v-bind="attrs"
      class="ui-select__trigger"
      type="button"
      role="combobox"
      :aria-controls="listboxId"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :disabled="disabled"
      @click="toggleMenu"
      @keydown="onKeydown"
    >
      <span class="ui-select__value" :class="{ 'is-placeholder': !selectedOption }">
        <img v-if="selectedOption?.icon" class="ui-select__icon" :src="selectedOption.icon" alt="" />
        <span class="ui-select__value-text">{{ displayLabel }}</span>
      </span>
      <Icon class="ui-select__chevron" name="chevron-down" size="sm" />
    </button>

    <div v-if="open" :id="listboxId" ref="listRef" class="ui-select__menu" role="listbox">
      <template v-for="(option, index) in options" :key="`${option.group ?? ''}:${option.value}`">
        <div
          v-if="option.group && option.group !== options[index - 1]?.group"
          class="ui-select__group"
        >
          {{ option.group }}
        </div>
        <button
          :ref="(el) => setOptionRef(el, index)"
          class="ui-select__option"
          :class="{ 'is-selected': index === selectedIndex, 'is-active': index === activeIndex }"
          type="button"
          role="option"
          :aria-selected="index === selectedIndex"
          :disabled="option.disabled"
          @mouseenter="activeIndex = index"
          @click="selectOption(option)"
        >
          <Icon class="ui-select__check" name="check" size="sm" />
          <img v-if="option.icon" class="ui-select__icon ui-select__icon--option" :src="option.icon" alt="" />
          <span>{{ option.label }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ui-select {
  position: relative;
  width: 100%;
  font-family: var(--font-ui);
}
.ui-select.is-open { z-index: var(--z-dropdown); }
.ui-select__trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 100%;
  padding: 0 var(--space-3);
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: transparent;
  box-shadow: none;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out),
    background var(--duration-base) var(--ease-out);
}
.ui-select--md { height: 38px; }
.ui-select--sm { height: 32px; }
.ui-select--sm .ui-select__trigger { font-size: var(--text-sm); }
.ui-select__trigger:hover:not(:disabled) { border-color: var(--color-line-strong); }
.ui-select__trigger:focus-visible,
.ui-select.is-open .ui-select__trigger {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: var(--p-focus-ring);
}
.ui-select.has-error .ui-select__trigger { border-color: var(--color-danger); }
.ui-select.has-error .ui-select__trigger:focus-visible { box-shadow: 0 0 0 3px var(--color-danger-soft); }
.ui-select__value {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  overflow: hidden;
  white-space: nowrap;
}
.ui-select__value-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ui-select__value.is-placeholder { color: var(--color-text-faint); }
.ui-select__icon { flex: none; width: 14px; height: 14px; border-radius: 3px; }
.ui-select__icon--option { width: 16px; height: 16px; border-radius: 4px; }
.ui-select__chevron {
  flex: none;
  color: var(--color-text-muted);
  transition: transform var(--duration-base) var(--ease-out);
}
.ui-select.is-open .ui-select__chevron { transform: rotate(180deg); }
.ui-select.is-disabled { opacity: 0.5; }
.ui-select.is-disabled .ui-select__trigger { cursor: not-allowed; }
.ui-select__menu {
  position: absolute;
  z-index: var(--z-dropdown);
  top: calc(100% + var(--space-1));
  left: 0;
  width: 100%;
  max-height: 260px;
  overflow-y: auto;
  padding: var(--space-1);
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  box-shadow: var(--shadow-lg);
}
.ui-select__group {
  padding: var(--space-2) var(--space-2) var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}
.ui-select__option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 32px;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}
.ui-select__option.is-active { background: var(--color-hover); color: var(--color-text-strong); }
.ui-select__option:disabled { opacity: 0.45; cursor: not-allowed; }
.ui-select__check { flex: none; color: transparent; }
.ui-select__option.is-selected .ui-select__check { color: var(--color-accent); }
</style>
