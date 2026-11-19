<script setup lang="ts">
import { ref } from 'vue';
import TooltipBubble from './TooltipBubble.vue';

type Placement = 'top' | 'bottom' | 'left' | 'right';

withDefaults(
  defineProps<{
    text?: string | null;
    keys?: string[];
    placement?: Placement;
    maxWidth?: number;
    maxLines?: number;
  }>(),
  {
    keys: () => [],
    placement: 'top',
    maxWidth: 280,
    maxLines: 6,
  },
);

const trigger = ref<HTMLElement>();
</script>

<template>
  <span ref="trigger" class="ui-tip">
    <slot />
  </span>
  <TooltipBubble
    :delegate="trigger ?? null"
    :text="text"
    :keys="keys"
    :placement="placement"
    :max-width="maxWidth"
    :max-lines="maxLines"
  />
</template>

<style scoped>
.ui-tip { display: contents; }
</style>
