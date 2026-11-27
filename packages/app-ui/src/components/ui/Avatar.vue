<script setup lang="ts">
import { ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{
    src?: string;
    size?: 'sm' | 'md' | 'lg';
    shape?: 'square' | 'circle';
    fallbackIcon?: string;
  }>(),
  { size: 'md', shape: 'square', fallbackIcon: 'user' },
);

const loadFailed = ref(false);
watch(
  () => props.src,
  () => {
    loadFailed.value = false;
  },
);
</script>

<template>
  <span class="ui-avatar" :class="[`ui-avatar--${size}`, `ui-avatar--${shape}`]">
    <slot>
      <img v-if="src && !loadFailed" class="ui-avatar__img" :src="src" alt="" @error="loadFailed = true" />
      <Icon v-else :name="fallbackIcon" :size="size === 'sm' ? 'sm' : 'md'" />
    </slot>
  </span>
</template>

<style scoped>
.ui-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  overflow: hidden;
}
.ui-avatar--lg { width: 40px; height: 40px; font-size: var(--text-base); }
.ui-avatar--md { width: 32px; height: 32px; font-size: var(--text-sm); }
.ui-avatar--sm { width: 24px; height: 24px; font-size: var(--text-xs); border-radius: var(--radius-sm); }
.ui-avatar--circle { border: none; border-radius: var(--radius-full); }
.ui-avatar__img { width: 100%; height: 100%; object-fit: cover; }
</style>
