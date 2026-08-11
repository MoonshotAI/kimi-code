<!-- apps/kimi-web/src/components/ui/StatusDot.vue -->
<!-- Unified status dot (design-system-v2 §05): one color vocabulary for
     success / danger / active / idle, used by tool rows, tool groups and swarm.
     Accepts the various raw status spellings and normalizes them. -->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ status?: string }>();

type DotKind = 'ok' | 'error' | 'running' | 'suspended' | 'idle';

function normalize(s?: string): DotKind {
  switch (s) {
    case 'ok':
    case 'done':
    case 'completed':
    case 'success':
      return 'ok';
    case 'error':
    case 'failed':
    case 'danger':
      return 'error';
    case 'running':
    case 'working':
    case 'in_progress':
    case 'active':
      return 'running';
    case 'suspended':
      return 'suspended';
    default:
      return 'idle';
  }
}

const kind = computed(() => normalize(props.status));
</script>

<template>
  <span class="kw-dot" :class="`kw-dot--${kind}`" aria-hidden="true" />
</template>

<style scoped>
.kw-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-text-faint);
  flex: none;
}
.kw-dot--ok { background: var(--color-success); }
.kw-dot--error { background: var(--color-danger); }
.kw-dot--suspended { background: var(--color-warning); }
.kw-dot--running {
  background: var(--color-accent);
  animation: kw-dot-pulse 1.4s var(--ease-out) infinite;
}
@keyframes kw-dot-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 40%, transparent); }
  100% { box-shadow: 0 0 0 6px transparent; }
}
</style>
