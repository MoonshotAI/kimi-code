<script setup lang="ts">
import { Icon, IconButton } from '@moonshot-ai/app-ui';
import type { BrowserOverlayMenuItem } from '../../../shared/browser-overlay';

type ZoomMenuItem = Extract<BrowserOverlayMenuItem, { kind: 'zoom' }>;

withDefaults(
  defineProps<{
    item: ZoomMenuItem;
    showIconGutter?: boolean;
  }>(),
  { showIconGutter: false },
);
const emit = defineEmits<{ action: [actionId: string] }>();
</script>

<template>
  <div class="browser-overlay-zoom" role="group" :aria-label="item.label">
    <span
      v-if="showIconGutter"
      class="browser-overlay-zoom-icon"
      aria-hidden="true"
    >
      <Icon v-if="item.icon" :name="item.icon" size="md" />
    </span>
    <span class="browser-overlay-zoom-label">{{ item.label }}</span>
    <span class="browser-overlay-zoom-stepper">
      <IconButton
        size="sm"
        class="browser-overlay-zoom-control"
        :label="item.decreaseLabel"
        :tooltip="item.decreaseLabel"
        :disabled="item.decreaseDisabled"
        @click="emit('action', item.decreaseAction)"
      >
        <Icon name="minus" size="md" />
      </IconButton>
      <span class="browser-overlay-zoom-value">{{ item.value }}</span>
      <IconButton
        size="sm"
        class="browser-overlay-zoom-control"
        :label="item.increaseLabel"
        :tooltip="item.increaseLabel"
        :disabled="item.increaseDisabled"
        @click="emit('action', item.increaseAction)"
      >
        <Icon name="plus" size="md" />
      </IconButton>
    </span>
    <IconButton
      size="sm"
      class="browser-overlay-zoom-control browser-overlay-zoom-reset"
      :label="item.resetLabel"
      :tooltip="item.resetLabel"
      :disabled="item.resetDisabled"
      @click="emit('action', item.resetAction)"
    >
      <Icon name="refresh" size="md" />
    </IconButton>
  </div>
</template>

<style scoped>
.browser-overlay-zoom {
  display: flex;
  align-items: center;
  gap: var(--menu-row-gap-icon);
  padding: 0 var(--menu-item-padding-inline);
  min-height: calc(1lh + 2 * var(--menu-item-padding-block));
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  line-height: var(--leading-tight);
}

.browser-overlay-zoom-icon {
  width: var(--space-4);
  height: var(--space-4);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.browser-overlay-zoom-label {
  flex: 1;
  min-width: 0;
}

.browser-overlay-zoom-stepper {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}

.browser-overlay-zoom-value {
  min-width: var(--space-12);
  text-align: center;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.browser-overlay-zoom-reset {
  color: var(--color-text-muted);
}
</style>
