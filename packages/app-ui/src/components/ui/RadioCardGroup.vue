<script setup lang="ts">
import { nextTick, ref } from 'vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string; description?: string }[];
  ariaLabel?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

defineSlots<{
  'description-addon'?: (props: { option: { value: string; label: string; description?: string } }) => unknown;
  detail?: (props: { option: { value: string; label: string; description?: string }; selected: boolean }) => unknown;
}>();

const root = ref<HTMLElement>();

function tabIndexOf(value: string, index: number): number {
  const hasSelection = props.options.some((option) => option.value === props.modelValue);
  if (hasSelection) return value === props.modelValue ? 0 : -1;
  return index === 0 ? 0 : -1;
}

function select(value: string): void {
  if (props.disabled || value === props.modelValue) return;
  emit('update:modelValue', value);
}

function onCardClick(event: MouseEvent, value: string): void {
  if (event.target instanceof Element && event.target.closest('.ui-radio-card__detail')) return;
  select(value);
}

function onKeydown(event: KeyboardEvent, index: number): void {
  const count = props.options.length;
  if (count === 0) return;
  let next: number;
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % count;
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + count) % count;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = count - 1;
  else return;
  event.preventDefault();
  const option = props.options[next];
  if (option === undefined) return;
  select(option.value);
  void nextTick(() => root.value?.querySelectorAll<HTMLElement>('.ui-radio-card__radio')[next]?.focus());
}
</script>

<template>
  <div ref="root" class="ui-radio-cards" :class="{ 'is-disabled': disabled }" role="radiogroup" :aria-label="ariaLabel">
    <div
      v-for="(option, index) in options"
      :key="option.value"
      class="ui-radio-card"
      :class="{ 'is-on': option.value === modelValue }"
      @click="onCardClick($event, option.value)"
    >
      <div class="ui-radio-card__main">
        <button
          class="ui-radio-card__radio"
          type="button"
          role="radio"
          :aria-checked="option.value === modelValue"
          :tabindex="tabIndexOf(option.value, index)"
          :disabled="disabled"
          @keydown="onKeydown($event, index)"
        >
          <span class="ui-radio-card__dot" aria-hidden="true" />
          <span class="ui-radio-card__text">
            <span class="ui-radio-card__label">{{ option.label }}</span>
            <span v-if="option.description" class="ui-radio-card__description">{{ option.description }}</span>
          </span>
        </button>
        <div v-if="$slots['description-addon']" class="ui-radio-card__description-addon">
          <slot name="description-addon" :option="option" />
        </div>
      </div>
      <div
        v-if="$slots.detail && option.value === modelValue"
        class="ui-radio-card__detail"
      >
        <slot name="detail" :option="option" :selected="option.value === modelValue" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ui-radio-cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.ui-radio-cards.is-disabled { opacity: 0.5; }
.ui-radio-card {
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
  cursor: pointer;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out),
    background var(--duration-base) var(--ease-out);
}
.ui-radio-card:hover:not(.is-on) { background: var(--color-hover); }
.ui-radio-cards.is-disabled .ui-radio-card { cursor: not-allowed; }
.ui-radio-card.is-on {
  border-color: var(--color-accent);
  box-shadow: inset 0 0 0 0.5px var(--color-accent);
  cursor: default;
}
.ui-radio-card:has(.ui-radio-card__radio:focus-visible) {
  box-shadow: var(--p-focus-ring);
}
.ui-radio-card.is-on:has(.ui-radio-card__radio:focus-visible) {
  box-shadow: inset 0 0 0 0.5px var(--color-accent), var(--p-focus-ring);
}
.ui-radio-card__main {
  position: relative;
}
.ui-radio-card__main:has(.ui-radio-card__description-addon:not(:empty)) .ui-radio-card__radio {
  padding-right: var(--space-8);
}
.ui-radio-card__description-addon {
  position: absolute;
  right: var(--space-2);
  bottom: var(--space-2);
  display: flex;
}
.ui-radio-card__radio {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3);
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: inherit;
}
.ui-radio-card__radio:focus-visible { outline: none; }
.ui-radio-card__dot {
  box-sizing: border-box;
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  transition: border var(--duration-base) var(--ease-out);
}
.ui-radio-card.is-on .ui-radio-card__dot { border: 5px solid var(--color-accent); background: var(--color-text-on-accent); }
.ui-radio-card__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ui-radio-card__label {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  line-height: var(--leading-tight);
  color: var(--color-text);
}
.ui-radio-card__description {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--color-text-muted);
}
.ui-radio-card__detail:empty { display: none; }
.ui-radio-card__detail {
  padding: 0 var(--space-3) var(--space-3) calc(var(--space-3) + 16px + var(--space-3));
  cursor: default;
}
</style>
