<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, Kbd, Menu, MenuItem, useImeComposition } from '@moonshot-ai/app-ui';
import { clampOverlayAxis, constrainOverlayViewport, installImeCompositionLatch, isContextClick, isImeKeyEvent, nextMenuIndex, selectionHitByPointer, type SelectionActionKind, type SelectionActionPayload } from '@moonshot-ai/app-client/lib';
import { resolveComposerBinding } from '@moonshot-ai/app-client/contracts';
import { isApplePlatform, isSelectAllKeyEvent } from '@moonshot-ai/app-core/lib';
import { useIsMobile } from '@moonshot-ai/app-client/composables';

const props = defineProps<{
  visible: boolean;
  x: number;
  y: number;
  bottom: number;
  px?: number;
  py?: number;
  quote: string;
  focusOnOpen?: boolean;
  focusReturnEl?: HTMLElement | null;
  boundaryEl?: HTMLElement | null;
  keepOnContextClick?: boolean;
}>();

const emit = defineEmits<{
  action: [payload: SelectionActionPayload];
  close: [];
}>();

const { t } = useI18n();
const isMobile = useIsMobile();
const isTouch = isMobile.value || (typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches === true);

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

const mode = ref<'menu' | 'comment'>('menu');
const commentText = ref('');
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);
const commentRowRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

function autosizeComment(): void {
  const el = inputRef.value;
  if (!el) return;
  const maxHeight = tokenPx('--p-selection-comment-max-h', 160);
  el.style.height = 'auto';
  const capped = el.scrollHeight > maxHeight;
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  el.style.overflowY = capped ? 'auto' : 'hidden';
}

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

const KEEP_SELECTION_HIGHLIGHT = 'kimi-selection-comment-keep';

type HighlightRegistryLike = { set(name: string, highlight: unknown): void; delete(name: string): void };

function highlightsRegistry(): HighlightRegistryLike | null {
  return (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS?.highlights ?? null;
}

function keepSelectionHighlight(): void {
  clearSelectionHighlight();
  const registry = highlightsRegistry();
  const HighlightCtor = (globalThis as { Highlight?: new (range: Range) => unknown }).Highlight;
  if (!registry || !HighlightCtor) return;
  const sel = window.getSelection();
  if (sel === null || sel.isCollapsed || sel.rangeCount !== 1) return;
  registry.set(KEEP_SELECTION_HIGHLIGHT, new HighlightCtor(sel.getRangeAt(0).cloneRange()));
}

function clearSelectionHighlight(): void {
  highlightsRegistry()?.delete(KEEP_SELECTION_HIGHLIGHT);
}

function dismiss(): void {
  clearSelectionHighlight();
  restoreFocus();
  emit('close');
}

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target)) return;
  const selection = window.getSelection();
  if (e.button === 0 && e.detail > 1 && selection?.rangeCount === 1 && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(target)) return;
  if (props.keepOnContextClick && isContextClick(e) && selectionHitByPointer(selection, e)) return;
  dismiss();
}

function onViewportResize(): void {
  if (mode.value === 'comment') {
    void updatePosition();
    return;
  }
  dismiss();
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.repeat || isImeKeyEvent(e)) return;
  e.stopPropagation();
  dismiss();
}

function attachListeners(): void {
  installImeCompositionLatch();
  document.addEventListener('mousedown', onDocClick);
  window.addEventListener('keydown', onDocKeydown, true);
  window.addEventListener('resize', onViewportResize);
  window.visualViewport?.addEventListener('resize', onViewportResize);
}

function detachListeners(): void {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', onViewportResize);
  window.visualViewport?.removeEventListener('resize', onViewportResize);
}

function tokenPx(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function updatePosition(fresh = false): Promise<void> {
  if (fresh) menuStyle.value = { visibility: 'hidden' };
  await nextTick();
  const menu = menuRef.value?.el;
  if (!menu) return;
  const gap = tokenPx('--space-1-5', 6);
  const margin = tokenPx('--p-mention-tip-vmargin', 12);
  const viewport = constrainOverlayViewport(
    {
      width: window.visualViewport?.width ?? window.innerWidth,
      height: window.visualViewport?.height ?? window.innerHeight,
      left: window.visualViewport?.offsetLeft ?? 0,
      top: window.visualViewport?.offsetTop ?? 0,
    },
    props.boundaryEl?.getBoundingClientRect(),
  );
  const viewportW = viewport.width;
  const viewportH = viewport.height;
  const offsetLeft = viewport.left;
  const offsetTop = viewport.top;
  const maxWidth = `${Math.max(0, Math.round(viewportW - 2 * margin))}px`;
  const maxHeight = `${Math.max(0, Math.round(viewportH - 2 * margin))}px`;
  menuStyle.value = { ...menuStyle.value, maxWidth, maxHeight };
  await nextTick();
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  const inputH = mode.value === 'comment' ? (inputRef.value?.getBoundingClientRect().height ?? 0) : 0;
  const fitH =
    mode.value === 'comment'
      ? Math.max(menuH, menuH - inputH + tokenPx('--p-selection-comment-max-h', 160))
      : menuH;
  let left: number;
  let above: boolean;
  let anchorY: number;
  if (props.px !== undefined && props.py !== undefined) {
    left = clampOverlayAxis(props.px, menuW, viewportW, margin, offsetLeft);
    const draggedDown = props.py >= (props.y + props.bottom) / 2;
    const fitsBelow = props.py + gap + fitH <= offsetTop + viewportH - margin;
    const fitsAbove = props.py - gap - fitH >= offsetTop + margin;
    above = draggedDown ? !fitsBelow && fitsAbove : fitsAbove || !fitsBelow;
    anchorY = above ? props.py - gap : props.py + gap;
  } else {
    left = clampOverlayAxis(props.x - menuW / 2, menuW, viewportW, margin, offsetLeft);
    const fitsBelow = props.bottom + gap + fitH <= offsetTop + viewportH - margin;
    const fitsAbove = props.y - gap - fitH >= offsetTop + margin;
    above = !fitsBelow && fitsAbove;
    anchorY = above ? props.y - gap : props.bottom + gap;
  }
  if (above) {
    const top = clampOverlayAxis(anchorY - menuH, menuH, viewportH, margin, offsetTop);
    const bottomEdge = top + menuH;
    menuStyle.value = {
      left: `${Math.round(left)}px`,
      bottom: `${Math.round(window.innerHeight - bottomEdge)}px`,
      maxWidth,
      maxHeight: `${Math.round(bottomEdge - offsetTop - margin)}px`,
    };
    return;
  }
  const top = clampOverlayAxis(anchorY, menuH, viewportH, margin, offsetTop);
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    maxWidth,
    maxHeight: `${Math.round(offsetTop + viewportH - margin - top)}px`,
  };
}

watch(
  () => [props.visible, props.x, props.y, props.bottom, props.px, props.py, props.boundaryEl] as const,
  ([visible], prev) => {
    if (visible) {
      if (prev?.[0] !== true) {
        mode.value = 'menu';
        commentText.value = '';
        previouslyFocused = document.activeElement as HTMLElement | null;
        attachListeners();
      }
      void updatePosition(prev?.[0] !== true).then(() => {
        if (prev?.[0] !== true && props.focusOnOpen) {
          menuItemEls()[0]?.focus();
        }
      });
    } else {
      clearSelectionHighlight();
      detachListeners();
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  clearSelectionHighlight();
  detachListeners();
});

function menuItemEls(): HTMLButtonElement[] {
  return Array.from(menuRef.value?.el?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (mode.value === 'comment') {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const input = inputRef.value;
    const buttons = Array.from(commentRowRef.value?.querySelectorAll<HTMLButtonElement>('.sab-actions button:not(:disabled)') ?? []);
    const focusables: HTMLElement[] = input ? [input, ...buttons] : buttons;
    if (focusables.length === 0) return;
    const current = focusables.findIndex((el) => el === document.activeElement);
    const next = nextMenuIndex(current, e.shiftKey ? -1 : 1, focusables.length);
    focusables[next]?.focus();
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
  keepSelectionHighlight();
  mode.value = 'comment';
  await updatePosition();
  const el = inputRef.value;
  if (el) {
    el.style.height = '';
    el.focus();
  }
}

function confirmComment(): void {
  const comment = commentText.value.trim();
  if (comment.length === 0) {
    inputRef.value?.focus();
    return;
  }
  clearSelectionHighlight();
  emitAction('comment', comment);
}

function onCommentInput(): void {
  autosizeComment();
}

function onInputKeydown(e: KeyboardEvent): void {
  if (isSelectAllKeyEvent(e)) {
    e.preventDefault();
    inputRef.value?.select();
    return;
  }
  if (isComposingKeyEvent(e)) return;
  const keyCtx = { expanded: false };
  const newlineBinding = resolveComposerBinding('newline', keyCtx);
  if (newlineBinding !== null && newlineBinding.matches(e)) {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) return;
    e.preventDefault();
    document.execCommand('insertText', false, '\n');
    return;
  }
  const sendBinding = resolveComposerBinding('send', keyCtx);
  if (sendBinding !== null && sendBinding.matches(e)) {
    e.preventDefault();
    confirmComment();
    return;
  }
  const swallowBinding = resolveComposerBinding('swallow', keyCtx);
  if (swallowBinding !== null && swallowBinding.matches(e)) {
    e.preventDefault();
  }
}

const enterHintKeys = computed<string[] | null>(() => {
  if (typeof KeyboardEvent === 'undefined') return ['enter'];
  const binding = resolveComposerBinding('send', { expanded: false });
  if (binding === null) return null;
  if (binding.matches(new KeyboardEvent('keydown', { key: 'Enter' }))) return ['enter'];
  const apple = isApplePlatform();
  const modProbe = new KeyboardEvent('keydown', { key: 'Enter', metaKey: apple, ctrlKey: !apple });
  return binding.matches(modProbe) ? ['mod', 'enter'] : null;
});
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
      </template>
      <div v-else ref="commentRowRef" class="sab-comment">
        <textarea
          ref="inputRef"
          v-model="commentText"
          class="sab-input"
          rows="1"
          :placeholder="t('selection.commentPlaceholder')"
          @input="onCommentInput"
          @keydown="onInputKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        ></textarea>
        <div class="sab-actions">
          <Button :size="isTouch ? 'lg' : 'sm'" variant="secondary" :class="{ 'is-touch': isTouch }" @click="dismiss">
            {{ t('common.cancel') }}
          </Button>
          <Button
            :size="isTouch ? 'lg' : 'sm'"
            variant="primary"
            :class="{ 'is-touch': isTouch }"
            :disabled="commentText.trim().length === 0"
            @click="confirmComment"
          >
            {{ t('selection.addToChat') }}<Kbd v-if="enterHintKeys !== null" class="sab-enter" :keys="enterHintKeys" variant="button" />
          </Button>
        </div>
      </div>
    </Menu>
  </Teleport>
</template>

<style scoped>
.sab {
  position: fixed;
  z-index: var(--z-dropdown);
  min-width: 0;
  max-width: calc(100vw - 2 * var(--p-mention-tip-vmargin));
  max-height: calc(100vh - 2 * var(--p-mention-tip-vmargin));
  overflow-y: auto;
  -webkit-app-region: no-drag;
}
.sab :deep(.ui-menu-item) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sab-comment {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  flex-shrink: 0;
  gap: var(--space-2);
  width: var(--p-selection-bubble-w);
  max-width: 100%;
  padding: var(--space-1);
}
.sab-input {
  min-width: 0;
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface-overlay);
  box-shadow: var(--shadow-xs);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  padding: var(--space-1-5) var(--space-2);
  resize: none;
  overflow-y: hidden;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.sab-input::placeholder {
  color: var(--color-text-faint);
}
.sab-input:focus {
  outline: none;
  border-color: var(--color-composer-focus-line);
  box-shadow: var(--shadow-xs);
}
.sab-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
.sab-actions .ui-button.is-touch {
  height: var(--touch-target-min);
}
.sab-enter {
  margin-left: var(--space-1);
}
</style>
