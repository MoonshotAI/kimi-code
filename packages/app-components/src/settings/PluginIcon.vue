<script setup lang="ts">
import { ref, watch } from 'vue';
import { Icon } from '@moonshot-ai/app-ui';

const props = withDefaults(defineProps<{
  src?: string;
  size?: 'md' | 'lg';
}>(), { size: 'md' });

const failed = ref(false);
watch(() => props.src, () => {
  failed.value = false;
});
</script>

<template>
  <span class="plugin-icon" :class="`plugin-icon--${size}`">
    <img
      v-if="src && !failed"
      class="plugin-icon__image"
      :src="src"
      alt=""
      @error="failed = true"
    >
    <Icon v-else name="plugin" :size="size === 'lg' ? 'lg' : 'md'" />
  </span>
</template>

<style scoped>
.plugin-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  overflow: hidden;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface-sunken);
  color: var(--color-text-faint);
}

.plugin-icon--md {
  width: 36px;
  height: 36px;
}

.plugin-icon--lg {
  width: 48px;
  height: 48px;
}

.plugin-icon__image {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
