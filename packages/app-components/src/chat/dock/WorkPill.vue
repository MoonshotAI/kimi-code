<script setup lang="ts">
import { Icon, Pill } from '@moonshot-ai/app-ui';

defineProps<{
  icon: string;
  active?: boolean;
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
