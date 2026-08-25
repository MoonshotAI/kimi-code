<!-- One dock workbar pill: leading icon + label + an optional trailing meta
     (task count, live goal status). The look stays in ChatDock's
     .dock-workbar :deep rules — this is only the structure the four work
     pills repeat. -->
<script setup lang="ts">
import { Icon, Pill } from '@moonshot-ai/app-ui';

defineProps<{
  icon: string;
  active?: boolean;
  /** Accessible name — the collapsed icon-only pill would otherwise be
      nameless to screen readers. */
  label: string;
}>();

const emit = defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
  <Pill :active="active" :aria-pressed="active" :aria-label="label" @click="emit('click', $event)">
    <Icon :name="icon" size="md" />
    <span><slot /></span>
    <slot name="meta" />
  </Pill>
</template>
