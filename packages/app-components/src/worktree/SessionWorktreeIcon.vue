<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@moonshot-ai/app-ui';

const props = withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg';
  slashed?: boolean;
  remote?: boolean;
  label?: string;
}>(), {
  size: 'md',
  slashed: false,
  remote: false,
  label: undefined,
});

const name = computed(() => {
  if (props.slashed) return 'git-fork-off';
  return props.remote ? 'git-fork-cloud' : 'git-fork';
});
</script>

<template>
  <span class="swi" :data-worktree-icon="name">
    <Icon :name="name" :size="size" :label="label" />
  </span>
</template>

<style scoped>
.swi {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}
</style>
