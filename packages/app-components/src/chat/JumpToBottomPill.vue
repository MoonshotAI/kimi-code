<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';

defineProps<{ show: boolean; label?: string; ariaLabel?: string }>();
const emit = defineEmits<{ click: [] }>();
const { t } = useI18n();
</script>

<template>
  <Transition name="jump-pill">
    <button v-if="show" class="jump-pill" type="button" :aria-label="ariaLabel" @click="emit('click')">
      <Icon class="jump-pill-car" name="arrow-down" size="sm" />
      <span>{{ label ?? t('conversation.backToBottom') }}</span>
    </button>
  </Transition>
</template>

<style scoped>
.jump-pill {
  position: absolute;
  left: 50%;
  bottom: var(--space-3);
  transform: translateX(-50%);
  z-index: var(--z-sticky);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px var(--space-3);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-ui-strong);
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.jump-pill-car {
  width: 12px;
  height: 12px;
}
.jump-pill:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.jump-pill-enter-active,
.jump-pill-leave-active {
  transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out);
}
.jump-pill-enter-from,
.jump-pill-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>
