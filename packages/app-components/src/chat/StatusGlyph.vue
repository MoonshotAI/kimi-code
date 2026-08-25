<!-- Shared status glyph for dock list rows (todo + background bash/subagent
     tasks). One glyph per state, drawn from the registry icons / StatusDot
     vocabulary (never hardcoded characters), colored by state — keeps the
     two lists visually identical. -->
<script setup lang="ts">
import { Icon, StatusDot } from '@moonshot-ai/app-ui';

export type StatusGlyphStatus = 'pending' | 'run' | 'done' | 'fail';

const props = defineProps<{ status: StatusGlyphStatus }>();
</script>

<template>
  <span class="status-glyph" :class="`s-${props.status}`" aria-hidden="true">
    <StatusDot v-if="props.status === 'run'" status="running" />
    <StatusDot v-else-if="props.status === 'pending'" status="idle" />
    <Icon v-else-if="props.status === 'done'" name="check" size="sm" />
    <Icon v-else name="close" size="sm" />
  </span>
</template>

<style scoped>
.status-glyph {
  flex: none;
  width: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.status-glyph.s-run { color: var(--color-accent); }
.status-glyph.s-done { color: var(--color-success); }
.status-glyph.s-fail { color: var(--color-danger); }
.status-glyph.s-pending { color: var(--color-text-faint); }
</style>
