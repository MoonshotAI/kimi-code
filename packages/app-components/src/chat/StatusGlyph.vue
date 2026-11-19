<script setup lang="ts">
import { Icon, Spinner } from '@moonshot-ai/app-ui';

export type StatusGlyphStatus = 'pending' | 'run' | 'done' | 'fail';

const props = defineProps<{ status: StatusGlyphStatus }>();
</script>

<template>
  <span class="status-glyph" :class="`s-${props.status}`" aria-hidden="true">
    <Spinner v-if="props.status === 'run'" size="md" />
    <Icon v-else-if="props.status === 'pending'" name="circle-empty" size="md" />
    <Icon v-else-if="props.status === 'done'" name="circle-check-filled" size="md" />
    <Icon v-else name="close" size="sm" />
  </span>
</template>

<style scoped>
.status-glyph {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  user-select: none;
}
.status-glyph :deep(.kw-icon) {
  width: 18px;
  height: 18px;
}
.status-glyph :deep(.ui-spinner) {
  color: inherit;
}
.status-glyph :deep(.ui-spinner__track),
.status-glyph :deep(.ui-spinner__arc) {
  stroke-width: 1.8;
}
.status-glyph.s-run { color: var(--color-text); }
.status-glyph.s-done { color: var(--color-fill-4); }
.status-glyph.s-fail { color: var(--color-danger); }
.status-glyph.s-pending { color: var(--color-fill-4); }
</style>
