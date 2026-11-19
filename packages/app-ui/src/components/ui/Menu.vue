<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { registerMenuSurface } from '../../composables/menuStack';

withDefaults(defineProps<{ role?: 'menu' | 'dialog' | 'listbox' }>(), { role: 'menu' });

const el = ref<HTMLElement>();
defineExpose({ el });

let releaseSurface: (() => void) | undefined;
onMounted(() => {
  if (el.value) releaseSurface = registerMenuSurface(el.value);
});
onBeforeUnmount(() => releaseSurface?.());
</script>

<template>
  <div ref="el" class="ui-menu" :role="role">
    <slot />
  </div>
</template>

<style scoped>
.ui-menu {
  min-width: 180px;
  padding: var(--menu-pad);
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  display: flex;
  flex-direction: column;
}
</style>
