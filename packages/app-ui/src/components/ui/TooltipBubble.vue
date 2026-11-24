<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { anyMenuOpen, isInOpenMenuSurface } from '../../composables/menuStack';
import { ensurePointerTracking, isSyntheticPointerMove } from '../../composables/pointerMovement';
import { subscribeViewportChange } from '../../composables/viewportDismiss';
import Kbd from './Kbd.vue';

type Placement = 'top' | 'bottom' | 'left' | 'right';

const props = withDefaults(
  defineProps<{
    target?: HTMLElement | null;
    delegate?: HTMLElement | null;
    text?: string | null;
    keys?: string[];
    placement?: Placement;
    arrow?: boolean;
    maxWidth?: number;
    maxLines?: number;
  }>(),
  {
    target: null,
    delegate: null,
    keys: () => [],
    placement: 'top',
    maxWidth: 280,
    maxLines: 6,
  },
);

const GAP = 6;
const MARGIN = 8;
const SHOW_DELAY = 150;

const bubble = ref<HTMLElement>();
const open = ref(false);
const positioned = ref(false);
const side = ref<Placement>(props.placement);
const bubbleStyle = ref<Record<string, string>>({ maxWidth: `${props.maxWidth}px` });

let showTimer: number | undefined;
let attachedTo: HTMLElement | null = null;
let observer: MutationObserver | undefined;
let hovering = false;

function anchor(): HTMLElement | null {
  if (props.target) return props.target;
  const shell = props.delegate;
  if (!shell) return null;
  return (shell.firstElementChild as HTMLElement | null) ?? shell;
}

function position(anchorEl: HTMLElement): void {
  const bub = bubble.value;
  if (!bub) return;
  const r = anchorEl.getBoundingClientRect();
  const bw = bub.offsetWidth;
  const bh = bub.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let place = props.placement;
  const gap = props.arrow ? 4 : GAP;
  if (place === 'top' && r.top - gap - bh < MARGIN) place = 'bottom';
  else if (place === 'bottom' && r.bottom + gap + bh > vh - MARGIN) place = 'top';
  else if (place === 'left' && r.left - gap - bw < MARGIN) place = 'right';
  else if (place === 'right' && r.right + gap + bw > vw - MARGIN) place = 'left';
  side.value = place;

  let top = 0;
  let left = 0;
  if (place === 'top') {
    top = r.top - gap - bh;
    left = r.left + r.width / 2 - bw / 2;
  } else if (place === 'bottom') {
    top = r.bottom + gap;
    left = r.left + r.width / 2 - bw / 2;
  } else if (place === 'left') {
    top = r.top + r.height / 2 - bh / 2;
    left = r.left - gap - bw;
  } else {
    top = r.top + r.height / 2 - bh / 2;
    left = r.right + gap;
  }

  left = Math.min(Math.max(left, MARGIN), vw - MARGIN - bw);
  top = Math.min(Math.max(top, MARGIN), vh - MARGIN - bh);

  bubbleStyle.value = {
    maxWidth: `${props.maxWidth}px`,
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    '--tip-anchor-x': `${r.left + r.width / 2 - left}px`,
    '--tip-anchor-y': `${r.top + r.height / 2 - top}px`,
  };
}

function tooltipSuppressed(): boolean {
  return anyMenuOpen.value && !isInOpenMenuSurface(anchor());
}

function show(): void {
  if (!props.text) return;
  if (tooltipSuppressed()) return;
  const anchorEl = anchor();
  if (!anchorEl) return;
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    if (!anchorEl.isConnected || tooltipSuppressed()) return;
    bubbleStyle.value = { maxWidth: `${props.maxWidth}px` };
    open.value = true;
    positioned.value = false;
    void nextTick(() => {
      position(anchorEl);
      positioned.value = true;
    });
  }, SHOW_DELAY);
}

function hide(): void {
  window.clearTimeout(showTimer);
  hovering = false;
  open.value = false;
  positioned.value = false;
}

function onDirectPointerMove(event: PointerEvent): void {
  if (hovering || isSyntheticPointerMove(event)) return;
  hovering = true;
  show();
}

function onFocus(event: FocusEvent): void {
  if (!(event.target instanceof Element) || !event.target.matches(':focus-visible')) return;
  if (props.delegate && ownerOf(event.target) !== props.delegate) return;
  show();
}

function onDirectLeave(): void {
  hide();
}

function ownerOf(el: EventTarget | null): HTMLElement | null {
  return el instanceof Element ? el.closest<HTMLElement>('.ui-tip') : null;
}

function onDelegatePointerMove(event: PointerEvent): void {
  const shell = props.delegate;
  if (!shell) return;
  if (ownerOf(event.target) !== shell) {
    hide();
    return;
  }
  if (hovering || isSyntheticPointerMove(event)) return;
  hovering = true;
  show();
}

function onDelegateOut(event: MouseEvent): void {
  const shell = props.delegate;
  if (!shell) return;
  const to = event.relatedTarget;
  if (to instanceof Element && shell.contains(to)) return;
  hide();
}

function onDelegateBlur(): void {
  hide();
}

function detach(): void {
  if (!attachedTo) return;
  attachedTo.removeEventListener('focusin', onFocus);
  if (props.delegate) {
    attachedTo.removeEventListener('pointermove', onDelegatePointerMove);
    attachedTo.removeEventListener('mouseout', onDelegateOut);
    attachedTo.removeEventListener('focusout', onDelegateBlur);
  } else {
    attachedTo.removeEventListener('pointermove', onDirectPointerMove);
    attachedTo.removeEventListener('mouseleave', onDirectLeave);
    attachedTo.removeEventListener('focusout', onDirectLeave);
  }
  attachedTo = null;
}

function attach(): void {
  detach();
  observer?.disconnect();
  observer = undefined;
  const el = props.target ?? props.delegate;
  if (!el) return;
  attachedTo = el;
  el.addEventListener('focusin', onFocus);
  if (props.delegate) {
    el.addEventListener('pointermove', onDelegatePointerMove, { passive: true });
    el.addEventListener('mouseout', onDelegateOut);
    el.addEventListener('focusout', onDelegateBlur);
    observer = new MutationObserver(() => {
      if (open.value) hide();
    });
    observer.observe(el, { childList: true });
  } else {
    el.addEventListener('pointermove', onDirectPointerMove, { passive: true });
    el.addEventListener('mouseleave', onDirectLeave);
    el.addEventListener('focusout', onDirectLeave);
  }
}

watch(() => [props.target, props.delegate], () => {
  hide();
  attach();
});

watch(anyMenuOpen, (menuOpen) => {
  if (menuOpen && !isInOpenMenuSurface(anchor())) hide();
});

watch(() => props.text, (text) => {
  if (!text) hide();
});

let unsubscribeViewport: (() => void) | null = null;

watch(open, (isOpen) => {
  if (isOpen) {
    unsubscribeViewport ??= subscribeViewportChange(hide);
    return;
  }
  unsubscribeViewport?.();
  unsubscribeViewport = null;
});

onMounted(() => {
  ensurePointerTracking();
  attach();
});

onBeforeUnmount(() => {
  window.clearTimeout(showTimer);
  observer?.disconnect();
  detach();
  unsubscribeViewport?.();
  unsubscribeViewport = null;
});
</script>

<template>
  <Teleport v-if="open" to="body">
    <div
      ref="bubble"
      class="ui-tip-surface ui-tip__bubble"
      :class="{ positioned, 'ui-tip__bubble--keys': keys.length > 0, 'ui-tip__bubble--arrow': arrow }"
      :data-side="arrow ? side : undefined"
      :style="[bubbleStyle, { '--tip-lines': maxLines }]"
      role="tooltip"
    >
      <template v-if="keys.length > 0">
        <span class="ui-tip__label">{{ text }}</span>
        <Kbd class="ui-tip__kbd" :keys="keys" variant="button" />
      </template>
      <template v-else>{{ text }}</template>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-tip__bubble {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--tip-lines);
  max-width: 280px;
  line-height: 1.35;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.ui-tip__bubble.positioned { opacity: 1; }
.ui-tip__bubble--arrow {
  overflow: visible;
  padding: 8px 12px;
  border-radius: 10px;
  background: #2b2b2b;
  color: white;
  font: 400 14px/20px "PingFang SC", var(--font-ui);
}
.ui-tip__bubble--arrow::after {
  content: '';
  position: absolute;
  width: 10px;
  height: 4px;
  background: inherit;
  clip-path: path('M10 0H0L4.37531 3.50024C4.74052 3.79242 5.25948 3.79242 5.62469 3.50024L10 0Z');
}
.ui-tip__bubble--arrow[data-side='top']::after { top: 100%; left: var(--tip-anchor-x); transform: translateX(-50%); }
.ui-tip__bubble--arrow[data-side='bottom']::after { bottom: 100%; left: var(--tip-anchor-x); transform: translateX(-50%) rotate(180deg); }
.ui-tip__bubble--arrow[data-side='left']::after { left: 100%; top: var(--tip-anchor-y); transform: translate(-3px, -50%) rotate(-90deg); }
.ui-tip__bubble--arrow[data-side='right']::after { right: 100%; top: var(--tip-anchor-y); transform: translate(3px, -50%) rotate(90deg); }
.ui-tip__bubble--keys {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.ui-tip__bubble--keys .ui-tip__label {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--tip-lines);
  overflow: hidden;
}
.ui-tip__bubble--keys .ui-tip__kbd {
  flex: none;
}
</style>
