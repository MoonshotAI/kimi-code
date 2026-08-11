<!-- apps/kimi-web/src/components/ui/Tooltip.vue -->
<!-- Design-system §03 Tooltip: hover/focus hint. Wrap the trigger in the default
     slot; text via prop. The wrapper is `display: contents` so it never alters the
     trigger's layout (safe for truncated/flex triggers). All behavior — timing,
     flip + viewport clamping, the body-teleported bubble — lives in the internal
     TooltipBubble, which listens on this wrapper via event delegation and resolves
     the actual anchor lazily at show time, so slotted content that mounts late,
     toggles via v-if, or gets replaced can never strand listeners or the bubble.
     Short text stays on one line; long text wraps within `maxWidth` and is clamped
     to `maxLines` lines with an ellipsis so the bubble never grows too tall. -->
<script setup lang="ts">
import { ref } from 'vue';
import TooltipBubble from './TooltipBubble.vue';

type Placement = 'top' | 'bottom' | 'left' | 'right';

withDefaults(
  defineProps<{
    text?: string | null;
    placement?: Placement;
    maxWidth?: number;
    /** Clamp the bubble to at most this many lines (with an ellipsis). */
    maxLines?: number;
  }>(),
  {
    placement: 'top',
    maxWidth: 280,
    maxLines: 6,
  },
);

const trigger = ref<HTMLElement>();
</script>

<template>
  <span ref="trigger" class="ui-tip">
    <slot />
  </span>
  <TooltipBubble
    :delegate="trigger ?? null"
    :text="text"
    :placement="placement"
    :max-width="maxWidth"
    :max-lines="maxLines"
  />
</template>

<style scoped>
.ui-tip { display: contents; }
</style>
