<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useKimiI18n } from '@moonshot-ai/app-i18n';
import Icon from './Icon.vue';
import TooltipBubble from './TooltipBubble.vue';

const props = withDefaults(defineProps<{
  modelValue?: number | null;
  min?: number;
  max?: number;
  step?: number;
  size?: 'sm' | 'md';
  placeholder?: number;
  disabled?: boolean;
  ariaLabel?: string;
}>(), {
  modelValue: null,
  min: Number.NEGATIVE_INFINITY,
  max: Number.POSITIVE_INFINITY,
  step: 1,
  size: 'sm',
});

const emit = defineEmits<{
  'update:modelValue': [value: number | null];
}>();

const { t } = useKimiI18n();

const el = ref<HTMLInputElement>();
const decEl = ref<HTMLButtonElement>();
const incEl = ref<HTMLButtonElement>();
const current = ref<number | null>(props.modelValue);
const text = ref(format(props.modelValue));
const editing = ref(false);

watch(
  () => props.modelValue,
  (value) => {
    current.value = value;
    if (!editing.value) text.value = format(value);
  },
);

function format(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function clamp(value: number): number {
  return Math.min(props.max, Math.max(props.min, value));
}

const effective = computed(() => current.value ?? props.placeholder ?? null);
const atMin = computed(() => effective.value !== null && effective.value <= props.min);
const atMax = computed(() => effective.value !== null && effective.value >= props.max);

function set(value: number | null): void {
  text.value = format(value);
  if (value === current.value) return;
  current.value = value;
  emit('update:modelValue', value);
}

function stepBy(direction: 1 | -1): void {
  if (props.disabled) return;
  const base = effective.value ?? (direction > 0 ? props.min : props.max);
  const next = Number.isFinite(base) ? clamp(base + direction * props.step) : 0;
  set(Number.isFinite(next) ? next : 0);
}

function commit(): void {
  const raw = text.value.trim();
  if (raw === '') {
    set(null);
    return;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    text.value = format(current.value);
    return;
  }
  set(clamp(n));
}

function onInput(event: Event): void {
  editing.value = true;
  text.value = (event.target as HTMLInputElement).value;
}

function onBlur(): void {
  editing.value = false;
  commit();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    editing.value = false;
    commit();
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    if (editing.value) {
      editing.value = false;
      commit();
    }
    stepBy(event.key === 'ArrowUp' ? 1 : -1);
  } else if (event.key === 'Escape' && editing.value) {
    event.preventDefault();
    editing.value = false;
    text.value = format(current.value);
  }
}

function focus(): void {
  el.value?.focus();
}
defineExpose({ focus, el });
</script>

<template>
  <div class="ui-number-input" :class="[`ui-number-input--${size}`, { 'is-disabled': disabled }]">
    <button
      ref="decEl"
      type="button"
      class="ui-number-input__step"
      tabindex="-1"
      :disabled="disabled || atMin"
      :aria-label="t('common.decrease')"
      @mousedown.prevent
      @click="stepBy(-1)"
    >
      <Icon class="ui-number-input__minus" name="minus" size="sm" />
      <TooltipBubble :target="decEl ?? null" :text="t('common.decrease')" />
    </button>
    <input
      ref="el"
      class="ui-number-input__field"
      type="text"
      inputmode="decimal"
      role="spinbutton"
      :value="text"
      :placeholder="placeholder === undefined ? undefined : String(placeholder)"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :aria-valuenow="effective ?? undefined"
      :aria-valuemin="Number.isFinite(min) ? min : undefined"
      :aria-valuemax="Number.isFinite(max) ? max : undefined"
      @input="onInput"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <button
      ref="incEl"
      type="button"
      class="ui-number-input__step"
      tabindex="-1"
      :disabled="disabled || atMax"
      :aria-label="t('common.increase')"
      @mousedown.prevent
      @click="stepBy(1)"
    >
      <Icon name="plus" size="sm" />
      <TooltipBubble :target="incEl ?? null" :text="t('common.increase')" />
    </button>
  </div>
</template>

<style scoped>
.ui-number-input {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: 0 var(--space-1);
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-overlay);
  box-shadow: var(--shadow-xs);
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.ui-number-input--md { height: 38px; }
.ui-number-input--sm { height: 32px; border-radius: var(--radius-sm); }
.ui-number-input:focus-within { border-color: var(--color-accent); box-shadow: var(--p-focus-ring); }
.ui-number-input.is-disabled { opacity: 0.5; cursor: not-allowed; }
.ui-number-input__field {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-variant-numeric: tabular-nums;
  line-height: var(--leading-normal);
  text-align: center;
}
.ui-number-input--sm .ui-number-input__field { font-size: var(--text-sm); }
.ui-number-input__field:focus { outline: none; }
.ui-number-input__field::placeholder { color: var(--color-text-faint); }
.ui-number-input__field:disabled { cursor: not-allowed; }
.ui-number-input__step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--icon-button-sm);
  height: var(--icon-button-sm);
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.ui-number-input__step:hover:not(:disabled) { background: var(--color-hover); color: var(--color-text); }
.ui-number-input__step:focus,
.ui-number-input__step:focus-visible { outline: none; }
.ui-number-input__minus { transform: scaleX(calc(20 / 12)); }
.ui-number-input__step:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
