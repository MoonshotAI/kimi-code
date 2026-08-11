<!-- apps/kimi-web/src/components/ui/TooltipBubble.vue -->
<!-- Internal shared tooltip bubble: owns show/hide timing, flip + viewport-clamp
     positioning, and the body-teleported bubble. Two attachment modes:
     - `target`   — direct anchor element (IconButton's self-anchored tooltip);
                    listeners attach to the element itself.
     - `delegate` — a shell element whose SUBTREE is the trigger (Tooltip's
                    display:contents slot wrapper). Listeners use mouseover /
                    mouseout event delegation on the shell, and the anchor is
                    resolved lazily at show time — so slotted content that
                    mounts late, toggles via v-if, or gets replaced never leaves
                    listeners stranded on a stale element. Nested shells win by
                    closest('.ui-tip') ownership: an inner trigger suppresses
                    the ancestor's hint while hovered.
     Not exported from the package index — use Tooltip, or IconButton's
     `tooltip` prop. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type Placement = 'top' | 'bottom' | 'left' | 'right';

const props = withDefaults(
  defineProps<{
    /** Direct anchor: listeners attach to this element (IconButton). */
    target?: HTMLElement | null;
    /** Delegation shell: listeners attach here with mouseover/mouseout
        delegation; the anchor is its firstElementChild, resolved at show
        time (Tooltip's slot wrapper). */
    delegate?: HTMLElement | null;
    text?: string | null;
    placement?: Placement;
    maxWidth?: number;
    /** Clamp the bubble to at most this many lines (with an ellipsis). */
    maxLines?: number;
  }>(),
  {
    target: null,
    delegate: null,
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
const bubbleStyle = ref<Record<string, string>>({ maxWidth: `${props.maxWidth}px` });

let showTimer: ReturnType<typeof setTimeout> | undefined;
let attachedTo: HTMLElement | null = null;
let observer: MutationObserver | undefined;

// The element the bubble positions against. In delegate mode the slotted
// trigger is re-resolved on every show, so v-if / late-mounted content just
// works; falls back to the shell itself when the slot is (still) empty.
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
  const anchorEl = anchor();
  if (!anchorEl) return;
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
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
  open.value = false;
  positioned.value = false;
}

/* -- direct mode (target) -------------------------------------------------- */

function onDirectEnter(): void {
  show();
}

function onDirectLeave(): void {
  hide();
}

/* -- delegate mode (shell + event delegation) ------------------------------- */

// Which tooltip shell owns the hover/focus: the innermost one containing the
// event target. Nested triggers (a badge tooltip inside a row tooltip) are
// resolved here without a shared registry.
function ownerOf(el: EventTarget | null): HTMLElement | null {
  return el instanceof Element ? el.closest<HTMLElement>('.ui-tip') : null;
}

function onDelegateOver(event: MouseEvent): void {
  const shell = props.delegate;
  if (!shell) return;
  if (ownerOf(event.target) !== shell) {
    // A nested trigger owns this hover — stand down (and close if open).
    hide();
    return;
  }
  const from = event.relatedTarget;
  // Moving between descendants of this shell is not a new entry; coming back
  // OUT of a nested shell is one (its owner differs from this shell).
  if (from instanceof Element && shell.contains(from) && ownerOf(from) === shell) return;
  show();
}

function onDelegateOut(event: MouseEvent): void {
  const shell = props.delegate;
  if (!shell) return;
  const to = event.relatedTarget;
  if (to instanceof Element && shell.contains(to)) return;
  hide();
}

function onDelegateFocus(event: FocusEvent): void {
  if (ownerOf(event.target) !== props.delegate) return;
  show();
}

function onDelegateBlur(): void {
  hide();
}

/* -- attach / detach -------------------------------------------------------- */

function detach(): void {
  if (!attachedTo) return;
  if (props.delegate) {
    attachedTo.removeEventListener('mouseover', onDelegateOver);
    attachedTo.removeEventListener('mouseout', onDelegateOut);
    attachedTo.removeEventListener('focusin', onDelegateFocus);
    attachedTo.removeEventListener('focusout', onDelegateBlur);
  } else {
    attachedTo.removeEventListener('mouseenter', onDirectEnter);
    attachedTo.removeEventListener('mouseleave', onDirectLeave);
    attachedTo.removeEventListener('focusin', onDirectEnter);
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
  if (props.delegate) {
    el.addEventListener('mouseover', onDelegateOver);
    el.addEventListener('mouseout', onDelegateOut);
    el.addEventListener('focusin', onDelegateFocus);
    el.addEventListener('focusout', onDelegateBlur);
    // If the slotted trigger is removed or replaced while open, the mouseout
    // we rely on never fires — close rather than strand the bubble on screen.
    observer = new MutationObserver(() => {
      if (open.value) hide();
    });
    observer.observe(el, { childList: true });
  } else {
    el.addEventListener('mouseenter', onDirectEnter);
    el.addEventListener('mouseleave', onDirectLeave);
    el.addEventListener('focusin', onDirectEnter);
    el.addEventListener('focusout', onDirectLeave);
  }
}

watch(() => [props.target, props.delegate], () => {
  hide();
  attach();
});

function onScrollOrResize(): void {
  if (open.value) hide();
}

onMounted(() => {
  attach();
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
});

onBeforeUnmount(() => {
  window.clearTimeout(showTimer);
  observer?.disconnect();
  detach();
  window.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize);
});
</script>

<template>
  <!-- Lazy mount: the bubble only teleports into <body> while open. With
       v-show every tooltip instance parked a dormant node (+ its teleport
       bookkeeping) in body for the app's whole lifetime — hundreds of them
       pile up in a long-lived window. -->
  <Teleport v-if="open" to="body">
    <div
      ref="bubble"
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
