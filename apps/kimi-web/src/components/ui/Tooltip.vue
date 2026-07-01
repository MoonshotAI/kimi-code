<!-- apps/kimi-web/src/components/ui/Tooltip.vue -->
<!-- Design-system §03 Tooltip: hover/focus hint. Wrap the trigger in the default
     slot; text via prop. The wrapper is `display: contents` so it never alters the
     trigger's layout (safe for truncated/flex triggers); listeners are attached to
     the real trigger element, which also anchors the bubble. The bubble is rendered
     through a body teleport so it escapes ancestor overflow clipping, and positioned
     with flip + viewport clamping. Short text stays on one line; long text wraps
     within `maxWidth` and is clamped to `maxLines` lines with an ellipsis so the
     bubble never grows too tall. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

type Placement = 'top' | 'bottom' | 'left' | 'right';

const props = withDefaults(
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

const GAP = 6;
const MARGIN = 8;
const SHOW_DELAY = 150;

const trigger = ref<HTMLElement>();
const bubble = ref<HTMLElement>();
const open = ref(false);
const positioned = ref(false);
const bubbleStyle = ref<Record<string, string>>({ maxWidth: `${props.maxWidth}px` });

let showTimer: ReturnType<typeof setTimeout> | undefined;
let target: HTMLElement | null = null;

function position(): void {
  const bub = bubble.value;
  if (!target || !bub) return;
  const r = target.getBoundingClientRect();
  const bw = bub.offsetWidth;
  const bh = bub.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let place = props.placement;
  if (place === 'top' && r.top - GAP - bh < MARGIN) place = 'bottom';
  else if (place === 'bottom' && r.bottom + GAP + bh > vh - MARGIN) place = 'top';
  else if (place === 'left' && r.left - GAP - bw < MARGIN) place = 'right';
  else if (place === 'right' && r.right + GAP + bw > vw - MARGIN) place = 'left';

  let top = 0;
  let left = 0;
  if (place === 'top') {
    top = r.top - GAP - bh;
    left = r.left + r.width / 2 - bw / 2;
  } else if (place === 'bottom') {
    top = r.bottom + GAP;
    left = r.left + r.width / 2 - bw / 2;
  } else if (place === 'left') {
    top = r.top + r.height / 2 - bh / 2;
    left = r.left - GAP - bw;
  } else {
    top = r.top + r.height / 2 - bh / 2;
    left = r.right + GAP;
  }

  left = Math.min(Math.max(left, MARGIN), vw - MARGIN - bw);
  top = Math.min(Math.max(top, MARGIN), vh - MARGIN - bh);

  bubbleStyle.value = {
    maxWidth: `${props.maxWidth}px`,
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

function show(): void {
  if (!props.text) return;
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    open.value = true;
    positioned.value = false;
    void nextTick(() => {
      position();
      positioned.value = true;
    });
  }, SHOW_DELAY);
}

function hide(): void {
  window.clearTimeout(showTimer);
  open.value = false;
  positioned.value = false;
}

function onScrollOrResize(): void {
  if (open.value) hide();
}

onMounted(() => {
  target = (trigger.value?.firstElementChild as HTMLElement | null) ?? trigger.value ?? null;
  if (!target) return;
  target.addEventListener('mouseenter', show);
  target.addEventListener('mouseleave', hide);
  target.addEventListener('focusin', show);
  target.addEventListener('focusout', hide);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
});

onBeforeUnmount(() => {
  window.clearTimeout(showTimer);
  if (target) {
    target.removeEventListener('mouseenter', show);
    target.removeEventListener('mouseleave', hide);
    target.removeEventListener('focusin', show);
    target.removeEventListener('focusout', hide);
  }
  window.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize);
});
</script>

<template>
  <span ref="trigger" class="ui-tip">
    <slot />
  </span>
  <Teleport to="body">
    <div
      ref="bubble"
      v-show="open"
      class="ui-tip__bubble"
      :class="{ positioned }"
      :style="[bubbleStyle, { '--tip-lines': maxLines }]"
      role="tooltip"
    >
      {{ text }}
    </div>
  </Teleport>
</template>

<style scoped>
.ui-tip { display: contents; }
.ui-tip__bubble {
  position: fixed;
  z-index: var(--z-tooltip);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--tip-lines);
  max-width: 280px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-text);
  color: var(--color-bg);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: 1.35;
  overflow: hidden;
  overflow-wrap: anywhere;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.ui-tip__bubble.positioned { opacity: 1; }
</style>
