<!-- apps/kimi-web/src/components/ui/Tooltip.vue -->
<!-- Design-system §03 Tooltip: hover/focus hint. Wrap the trigger in the default
     slot; text via prop. The wrapper is `display: contents` so it never alters the
     trigger's layout (safe for truncated/flex triggers); listeners are attached to
     the real trigger element, which also anchors the bubble, and re-attached if that
     element is removed or replaced (so an open tooltip can never strand on screen).
     The bubble is rendered through a body teleport so it escapes ancestor overflow
     clipping, and positioned with flip + viewport clamping. Short text stays on one
     line; long text wraps within `maxWidth` and is clamped to `maxLines` lines with
     an ellipsis so the bubble never grows too tall. -->
<script lang="ts">
// Nested triggers (a badge tooltip inside a row tooltip): the inner one wins —
// showing hides any instance whose target contains ours, and leaving re-arms
// the ancestor while the pointer is still inside it.
interface TipInstance {
  getTarget: () => HTMLElement | null;
  hide: () => void;
  show: () => void;
}
const tipInstances = new Set<TipInstance>();
// focusin bubbles, so a nested trigger's focusin also fires on the ancestors it
// just suppressed; the deepest instance claims the event and they stand down.
let claimedEvent: Event | undefined;
</script>

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
let observer: MutationObserver | undefined;

// The target is read lazily — the observer can re-point it at a replaced
// slotted element.
const self: TipInstance = { getTarget: () => target, hide, show };

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

function show(event?: Event): void {
  if (!props.text) return;
  if (event !== undefined) {
    if (event === claimedEvent) return;
    claimedEvent = event;
  }
  for (const tip of tipInstances) {
    const t = tip.getTarget();
    if (tip !== self && target && t && t !== target && t.contains(target)) tip.hide();
  }
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

// An ancestor we suppressed gets no new mouseenter while the pointer stays
// inside its trigger — re-arm it ourselves.
function rearmAncestors(): void {
  for (const tip of tipInstances) {
    const t = tip.getTarget();
    if (tip !== self && target && t && t !== target && t.contains(target) && t.matches(':hover, :focus-within')) {
      tip.show();
    }
  }
}

function onLeave(): void {
  hide();
  rearmAncestors();
}

function onScrollOrResize(): void {
  if (open.value) hide();
}

function setTarget(el: HTMLElement | null): void {
  if (el === target) return;
  if (target) {
    target.removeEventListener('mouseenter', show);
    target.removeEventListener('mouseleave', onLeave);
    target.removeEventListener('focusin', show);
    target.removeEventListener('focusout', onLeave);
  }
  target = el;
  if (target) {
    target.addEventListener('mouseenter', show);
    target.addEventListener('mouseleave', onLeave);
    target.addEventListener('focusin', show);
    target.addEventListener('focusout', onLeave);
  }
}

onMounted(() => {
  tipInstances.add(self);
  const root = trigger.value ?? null;
  setTarget((root?.firstElementChild as HTMLElement | null) ?? root);
  // Keep `target` in sync with the live slotted element: if it's removed or
  // replaced while the tooltip is open (e.g. a v-if toggles on hover), the
  // mouseleave we rely on never fires and the bubble would get stuck on screen.
  if (root) {
    observer = new MutationObserver(() => {
      const next = (root.firstElementChild as HTMLElement | null) ?? null;
      if (next !== target) {
        hide();
        setTarget(next ?? root);
        rearmAncestors();
      }
    });
    observer.observe(root, { childList: true });
  }
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
});

onBeforeUnmount(() => {
  // DOM is still mounted here — re-arm ancestors while our target still proves containment.
  rearmAncestors();
  tipInstances.delete(self);
  window.clearTimeout(showTimer);
  observer?.disconnect();
  setTarget(null);
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
