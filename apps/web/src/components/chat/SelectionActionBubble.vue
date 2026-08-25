<!-- Selection quote bubble (synced with apps/desktop): selecting text inside an
     assistant message pops this floating menu anchored to the selection —
     comment / add-to-chat / add-to-side-chat. "Comment" swaps the menu for an
     inline input in place. Positioning mirrors OpenInMenu's hand-rolled
     dropdown: fixed + teleported, viewport-margined, flipped when the
     selection sits too high; outside click / Esc (capture) / scroll / resize
     all close it. -->
<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, Input, Menu, MenuItem, useImeComposition } from '@moonshot-ai/app-ui';
import { clampOverlayAxis, installImeCompositionLatch, isImeKeyEvent, nextMenuIndex, type SelectionActionKind, type SelectionActionPayload } from '@moonshot-ai/app-client/lib';
import { useIsMobile } from '@moonshot-ai/app-client/composables';
import { isBubbleInternalScroll } from '@moonshot-ai/app-composer';

const props = defineProps<{
  visible: boolean;
  /** Selection anchor: horizontal center + top/bottom edges of the range rect. */
  x: number;
  y: number;
  /** Bottom edge of the range rect — the down-flip anchors here, so a flipped
      bubble never covers the selected text. */
  bottom: number;
  quote: string;
  /** Keyboard-driven open (Shift+Arrows): focus the first menu item so the
      bubble is operable without a mouse (§08 menu keyboard model). Mouse
      opens leave focus in the transcript. */
  focusOnOpen?: boolean;
  /** Focus-restoration fallback when the element focused at open time has
      left the DOM (ChatPane passes its chat root). */
  focusReturnEl?: HTMLElement | null;
}>();

const emit = defineEmits<{
  action: [payload: SelectionActionPayload];
  close: [];
}>();

const { t } = useI18n();
const isMobile = useIsMobile();
// Touch-capable devices (iPad, touch laptops — not just ≤640px phones) get
// the lg (≥44px) menu rows, same one-shot `(hover: none)` capability probe
// as ModelPicker/WarningToasts. Unioned with the narrow-viewport flag.
const isTouch = isMobile.value || (typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches === true);

// IME guard for the comment input: Enter/Esc that only resolve a composition
// candidate must not confirm/close (same latch usage as SideChatPanel's Enter
// and the document-level Esc handlers).
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

const mode = ref<'menu' | 'comment'>('menu');
const commentText = ref('');
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const inputRef = ref<InstanceType<typeof Input> | null>(null);
const commentRowRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

// Focus management (§08 overlay contract): record the element focused at
// open time; a DISMISS (outside click / Esc / scroll) restores it — falling
// back to focusReturnEl when it left the DOM. An ACTION (comment/quote/
// sidechat) deliberately does NOT restore: the action's own focus target
// (the composer, the side chat) owns focus from there.
let previouslyFocused: HTMLElement | null = null;

function restoreFocus(): void {
  const target = previouslyFocused;
  previouslyFocused = null;
  if (target && target.isConnected) {
    target.focus();
    return;
  }
  const fallback = props.focusReturnEl;
  if (fallback && fallback.isConnected) fallback.focus();
}

function dismiss(): void {
  restoreFocus();
  emit('close');
}

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target)) return;
  dismiss();
}

function onScrollResize(e?: Event): void {
  // A scroll INSIDE the bubble (the comment input's horizontal autoscroll on
  // a long comment) is not the outside-scroll dismiss — same guard as the
  // mention tooltip's.
  if (isBubbleInternalScroll(menuRef.value?.el ?? null, e?.target ?? null)) return;
  if (e?.type === 'resize' && mode.value === 'comment') {
    // The mobile soft keyboard fires window.resize right as the comment input
    // takes focus — reposition instead of closing mid-composition.
    void updatePosition();
    return;
  }
  dismiss();
}

// iOS Safari fires ONLY visualViewport resize/scroll for the soft keyboard
// (the layout viewport never shrinks, so window.innerHeight is unchanged) —
// mirror MentionMenu's listener pair. Comment mode repositions into the
// shrunken viewport; menu mode keeps the close behavior.
function onVisualViewport(): void {
  if (mode.value === 'comment') {
    void updatePosition();
    return;
  }
  dismiss();
}

// Same capture-phase Escape swallow as OpenInMenu: ConversationPane reads any
// Escape during a running turn as "interrupt the prompt", so the bubble owns
// the key while open (cancelling the comment closes the whole bubble). The
// shared IME latch filters an Esc that merely cancels a composition candidate
// (compositionend's trailing event included). Registered on WINDOW capture:
// propagation runs window → document, so this fires BEFORE App's
// document-capture global keydown (which closes the detail panel) — one Esc
// closes only the topmost layer.
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.repeat || isImeKeyEvent(e)) return;
  e.stopPropagation();
  dismiss();
}

function attachListeners(): void {
  installImeCompositionLatch();
  document.addEventListener('mousedown', onDocClick);
  window.addEventListener('keydown', onDocKeydown, true);
  document.addEventListener('scroll', onScrollResize, true);
  window.addEventListener('resize', onScrollResize);
  window.visualViewport?.addEventListener('resize', onVisualViewport);
  window.visualViewport?.addEventListener('scroll', onVisualViewport);
}

function detachListeners(): void {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('keydown', onDocKeydown, true);
  document.removeEventListener('scroll', onScrollResize, true);
  window.removeEventListener('resize', onScrollResize);
  window.visualViewport?.removeEventListener('resize', onVisualViewport);
  window.visualViewport?.removeEventListener('scroll', onVisualViewport);
}

// Gap / viewport margin read from the design tokens (same recipe as
// mentionTooltip's tokenPx — parsed from the computed style so a scale
// adjustment reaches this overlay too); the literal fallbacks only cover a
// missing token.
function tokenPx(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function updatePosition(): Promise<void> {
  await nextTick();
  const menu = menuRef.value?.el;
  if (!menu) return;
  const gap = tokenPx('--space-1-5', 6);
  const margin = tokenPx('--p-mention-tip-vmargin', 12);
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  // The VISUAL viewport governs when present: on iOS the soft keyboard
  // shrinks AND displaces only it, and the bubble must clamp/cap into the
  // moved area (bounds shift by the offset instead of starting at 0).
  const viewportW = window.visualViewport?.width ?? window.innerWidth;
  const viewportH = window.visualViewport?.height ?? window.innerHeight;
  const offsetLeft = window.visualViewport?.offsetLeft ?? 0;
  const offsetTop = window.visualViewport?.offsetTop ?? 0;
  // Above the selection by default; flip below when there isn't room —
  // anchored to the range's bottom edge so the flip never covers the
  // selected text. Both axes clamp to the viewport margin at BOTH ends (an
  // oversized menu at high zoom would otherwise clamp to a negative offset).
  const left = clampOverlayAxis(props.x - menuW / 2, menuW, viewportW, margin, offsetLeft);
  let top = props.y - menuH - gap;
  if (top < offsetTop + margin) top = props.bottom + gap;
  top = clampOverlayAxis(top, menuH, viewportH, margin, offsetTop);
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    // Inline so they follow the live (visual) viewport — the CSS max-width /
    // max-height stay the coarse fallbacks (iOS pinch zoom shrinks only the
    // visual viewport, never the layout one the CSS 100vw reads). No lower
    // bound: under extreme zoom + soft keyboard the actual usable size can be
    // arbitrarily small, and the position clamp already keeps the top-left
    // inside.
    maxWidth: `${Math.round(viewportW - 2 * margin)}px`,
    maxHeight: `${Math.round(viewportH - 2 * margin)}px`,
  };
}

watch(
  () => [props.visible, props.x, props.y, props.bottom] as const,
  ([visible], prev) => {
    if (visible) {
      if (prev?.[0] !== true) {
        // Fresh open: reset to the menu state and arm dismissal listeners.
        mode.value = 'menu';
        commentText.value = '';
        previouslyFocused = document.activeElement as HTMLElement | null;
        attachListeners();
        if (props.focusOnOpen) {
          // Keyboard-driven open: focus the first item so the menu is
          // operable without a mouse (§08 menu keyboard model). Mouse opens
          // keep focus in the transcript.
          void nextTick(() => menuItemEls()[0]?.focus());
        }
      }
      // Fresh open AND anchor moves (a Shift+Arrow selection still growing)
      // alike: (re)anchor to the latest rect.
      void updatePosition();
    } else {
      detachListeners();
    }
  },
  { immediate: true },
);

onUnmounted(detachListeners);

// §08 menu keyboard model: ↑/↓ wrap through the items (DOM focus), Enter
// activates natively (the focused button), Esc rides the window-capture
// handler above. Focus only ever enters the menu on a keyboard-driven open.
function menuItemEls(): HTMLButtonElement[] {
  return Array.from(menuRef.value?.el?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (mode.value === 'comment') {
    // Focus trap: the comment dialog is a two-control loop (input ⇄
    // confirm) — Tab / Shift+Tab cycle inside it instead of leaking into
    // the page behind.
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const input = inputRef.value?.el;
    const button = commentRowRef.value?.querySelector<HTMLButtonElement>('.ui-button');
    if (!input || !button) return;
    (document.activeElement === input ? button : input).focus();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = menuItemEls();
  if (items.length === 0) return;
  e.preventDefault();
  const current = items.findIndex((el) => el === document.activeElement);
  const next = nextMenuIndex(current, e.key === 'ArrowDown' ? 1 : -1, items.length);
  items[next]?.focus();
}

function emitAction(action: SelectionActionKind, comment?: string): void {
  emit('action', { action, quote: props.quote, comment });
}

async function pickComment(): Promise<void> {
  mode.value = 'comment';
  await updatePosition();
  inputRef.value?.focus();
}

function confirmComment(): void {
  const comment = commentText.value.trim();
  if (comment.length === 0) {
    inputRef.value?.focus();
    return;
  }
  emitAction('comment', comment);
}

// Enter confirms — but an Enter that only resolves an IME composition
// candidate is the candidate's, not ours (SideChatPanel's Enter contract).
function onInputKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !isComposingKeyEvent(e)) {
    e.preventDefault();
    confirmComment();
  }
}
</script>

<template>
  <Teleport to="body">
    <Menu
      v-if="visible"
      ref="menuRef"
      class="sab"
      :style="menuStyle"
      :role="mode === 'menu' ? 'menu' : 'dialog'"
      :aria-label="mode === 'comment' ? t('selection.comment') : undefined"
      @keydown="onMenuKeydown"
    >
      <template v-if="mode === 'menu'">
        <MenuItem :size="isTouch ? 'lg' : 'md'" @click="pickComment">
          <Icon name="message" size="sm" />
          {{ t('selection.comment') }}
        </MenuItem>
        <MenuItem :size="isTouch ? 'lg' : 'md'" @click="emitAction('quote')">
          <Icon name="plus" size="sm" />
          {{ t('selection.addToChat') }}
        </MenuItem>
        <MenuItem :size="isTouch ? 'lg' : 'md'" @click="emitAction('sidechat')">
          <Icon name="chat-new" size="sm" />
          {{ t('selection.addToSideChat') }}
        </MenuItem>
      </template>
      <div v-else ref="commentRowRef" class="sab-comment">
        <Input
          ref="inputRef"
          v-model="commentText"
          size="sm"
          :placeholder="t('selection.commentPlaceholder')"
          @keydown="onInputKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        />
        <Button size="sm" :disabled="commentText.trim().length === 0" @click="confirmComment">
          {{ t('selection.confirm') }}
        </Button>
      </div>
    </Menu>
  </Teleport>
</template>

<style scoped>
.sab {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
  /* This bubble is the registered exception to Menu's 180px min-width: at
     pinch zoom the usable width can go under it, and the fixed minimum would
     overflow the visible area even with the inline maxWidth. Rows shrink
     and ellipsize instead. */
  min-width: 0;
  /* Tiny windows / high zoom: the position clamp only fixes the top-left —
     cap the surface itself (same margin token as updatePosition) and scroll,
     so every action stays reachable instead of cropping off-viewport. */
  max-width: calc(100vw - 2 * var(--p-mention-tip-vmargin));
  max-height: calc(100vh - 2 * var(--p-mention-tip-vmargin));
  overflow-y: auto;
}
/* Rows shrink and ellipsize inside the min-width:0 exception above. */
.sab :deep(.ui-menu-item) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sab-comment {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* Shrinkable: the parent surface is already capped to the live visual
     viewport — a fixed width would overflow it sideways at pinch zoom. */
  width: 100%;
  max-width: var(--p-selection-bubble-w);
  padding: var(--space-1);
}
</style>
