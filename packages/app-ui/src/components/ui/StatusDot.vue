<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  status?: string;
  size?: 'sm' | 'md' | 'lg';
  ring?: 'none' | 'halo' | 'surface';
}>(), {
  size: 'md',
  ring: 'none',
});

type DotKind = 'ok' | 'error' | 'running' | 'suspended' | 'unread' | 'archived' | 'idle';

function normalize(s?: string): DotKind {
  switch (s) {
    case 'ok':
    case 'done':
    case 'completed':
    case 'success':
      return 'ok';
    case 'error':
    case 'failed':
    case 'fail':
    case 'danger':
      return 'error';
    case 'running':
    case 'run':
    case 'working':
    case 'in_progress':
    case 'active':
      return 'running';
    case 'suspended':
      return 'suspended';
    case 'unread':
      return 'unread';
    case 'archived':
      return 'archived';
    default:
      return 'idle';
  }
}

const kind = computed(() => normalize(props.status));
</script>

<template>
  <span
    class="kw-dot"
    :class="[`kw-dot--${kind}`, `kw-dot--${size}`, ring !== 'none' && `kw-dot--ring-${ring}`]"
    aria-hidden="true"
  />
</template>

<style scoped>
.kw-dot {
  --dot-c: var(--color-text-faint);
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--dot-c);
  flex: none;
}
.kw-dot--sm { width: 6px; height: 6px; }
.kw-dot--lg { width: 8px; height: 8px; }
.kw-dot--ok { --dot-c: var(--color-success); }
.kw-dot--error { --dot-c: var(--color-danger); }
.kw-dot--suspended { --dot-c: var(--color-warning); }
.kw-dot--unread { --dot-c: var(--color-accent); }
.kw-dot--archived { --dot-c: var(--color-done); }
.kw-dot--ring-halo { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dot-c) 18%, transparent); }
.kw-dot--ring-surface { box-shadow: 0 0 0 1.5px var(--color-surface, var(--color-bg)); }
.kw-dot--running {
  --dot-c: var(--color-accent);
  position: relative;
}
.kw-dot--running::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--dot-c) 40%, transparent);
  animation: kw-dot-pulse 1.4s var(--ease-out) infinite;
}
@keyframes kw-dot-pulse {
  0% { transform: scale(1); opacity: 1; }
  100% { transform: scale(2.7); opacity: 0; }
}
</style>
