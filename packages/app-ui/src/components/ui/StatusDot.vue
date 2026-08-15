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
  position: relative;
}
/* Expanding ring on a pseudo-element: transform/opacity run on the
   compositor, unlike a box-shadow pulse which repaints on the main thread
   every frame for every running row. Same 1.4s cadence as before: the ring
   grows from the dot's edge to a 6px halo while fading out. */
.kw-dot--running::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-accent) 40%, transparent);
  animation: kw-dot-pulse 1.4s var(--ease-out) infinite;
}
@keyframes kw-dot-pulse {
  0% { transform: scale(1); opacity: 1; }
  /* 7px dot + 6px halo on each side ≈ 2.7× the dot's diameter. */
  100% { transform: scale(2.7); opacity: 0; }
}
/* No component-level reduced-motion override: the apps' global rule now
   covers ::before/::after and caps this ring to a single 0.001ms iteration,
   same as every other pseudo-element animation. */
</style>
