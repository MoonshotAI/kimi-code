<script setup lang="ts">
defineProps<{
  label?: string;
  idle?: boolean;
  staticLabel?: boolean;
}>();
</script>

<template>
  <div class="working-indicator" :class="{ idle, 'static-label': staticLabel }" role="status">
    <span class="wi-face" aria-hidden="true">
      <span class="wi-eyes">
        <span class="wi-eye wi-eye--left" />
        <span class="wi-eye wi-eye--right" />
      </span>
    </span>
    <span v-if="label" class="wi-label">{{ label }}</span>
    <slot />
  </div>
</template>

<style scoped>
.working-indicator {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5) var(--space-3);
  align-self: flex-start;
  font-family: var(--markdown-font-family);
  font-size: var(--markdown-body-font-size);
  line-height: var(--markdown-body-line-height);
  color: var(--color-text-muted);
}

.wi-face {
  position: relative;
  flex: none;
  width: 24px;
  height: 16.125px;
  overflow: hidden;
  border-radius: 2.295px;
  background: var(--color-accent);
}
.wi-eyes {
  position: absolute;
  inset: 0;
  animation: wi-glance 2.4s var(--ease-in-out) infinite;
}
.wi-eye {
  position: absolute;
  top: calc(50% - 2.81px);
  width: 3px;
  height: 4.5px;
  background: var(--color-text-on-accent);
  transform: translate(-50%, -50%);
  animation: wi-blink 2.4s var(--ease-in-out) infinite;
}
.wi-eye--left {
  left: calc(50% - 1.8px);
}
.wi-eye--right {
  left: calc(50% + 7.2px);
}

.wi-label {
  animation: wi-breathe 1.6s var(--ease-in-out) infinite;
}

.working-indicator.idle .wi-eyes,
.working-indicator.idle .wi-eye,
.working-indicator.static-label .wi-label {
  animation: none;
}

@keyframes wi-glance {
  0%, 30% { transform: translateX(0); }
  40%, 55% { transform: translateX(-2px); }
  65%, 80% { transform: translateX(2px); }
  90%, 100% { transform: translateX(0); }
}
@keyframes wi-blink {
  0%, 88%, 100% { transform: translate(-50%, -50%) scaleY(1); }
  92% { transform: translate(-50%, -50%) scaleY(0.15); }
}
@keyframes wi-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wi-eyes,
  .wi-eye,
  .wi-label {
    animation: none;
  }
}
</style>
