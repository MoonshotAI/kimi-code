<script setup lang="ts">
import { isApplePlatform } from '@moonshot-ai/app-core/lib';
import { revealBrowserMenuSelection } from '../../lib/browserMenuNavigation';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { menuNavigationIndex, Badge, Button, Checkbox, Icon, IconButton, Input, Kbd, Menu, Switch, Textarea, Tooltip } from '@moonshot-ai/app-ui';
import {
  BROWSER_OVERLAY_GUTTER,
  type BrowserOverlayConfig,
  type BrowserOverlayActivateRequest,
  type BrowserOverlayDismissRequest,
  type BrowserOverlayFormAction,
  type BrowserOverlayMenuItem,
  type BrowserOverlayPlacement,
  type BrowserOverlayRendered,
  type BrowserOverlayShown,
  type BrowserOverlayVisibilityRequest,
} from '../../../shared/browser-overlay';
import AnnotationDetails from './AnnotationDetails.vue';
import AnnotationScroll from './AnnotationScroll.vue';
import BrowserOverlayMenuEntry from './BrowserOverlayMenuEntry.vue';
import { ModelQuickMenu } from '@moonshot-ai/app-components';
import type { QuickModelMenuAction } from '@moonshot-ai/app-core/quick-model-menu';
import { measureBrowserOverlayCard } from '../../lib/browserOverlaySize';

interface BrowserOverlayRendererBridge {
  ready: () => void;
  rendered: (payload: BrowserOverlayRendered) => void;
  hidden: (payload: BrowserOverlayVisibilityRequest) => void;
  activate: (payload: BrowserOverlayActivateRequest) => void;
  submitForm: (payload: BrowserOverlayFormAction) => void;
  dismiss: (payload: BrowserOverlayDismissRequest) => void;
  onConfig: (cb: (config: BrowserOverlayConfig) => void) => () => void;
  onShown: (cb: (payload: BrowserOverlayShown) => void) => () => void;
  onHide: (cb: (payload: BrowserOverlayVisibilityRequest) => void) => () => void;
}

const bridge = (
  window as unknown as { kimiBrowserOverlay?: BrowserOverlayRendererBridge }
).kimiBrowserOverlay;
const config = ref<BrowserOverlayConfig | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const modelMenuRef = ref<InstanceType<typeof ModelQuickMenu> | null>(null);
const modelMenuOffset = ref<{ x: number; y: number } | null>(null);
const modelMenuFrame = ref<{ x: number; y: number; viewportWidth: number; viewportHeight: number } | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
const inputValue = ref('');
const annotationInput = ref<InstanceType<typeof Textarea>>();
const reducedMotion = ref(false);
function insertClass(value: string): void {
  const el = annotationInput.value?.el;
  if (!el || el.readOnly) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const before = inputValue.value.slice(0, start);
  const after = inputValue.value.slice(end);
  const insertion = `${before && !/\s$/.test(before) ? ' ' : ''}${value}${after && !/^\s/.test(after) ? ' ' : ''}`;
  if (before.length + insertion.length + after.length > 10000) return;
  inputValue.value = before + insertion + after;
  void nextTick(() => { el.focus(); el.setSelectionRange(start + insertion.length, start + insertion.length); });
}
function annotationKeydown(event: KeyboardEvent): void {
  if (!event.isComposing && event.keyCode !== 229 && event.key === 'Enter' && (isApplePlatform() ? event.metaKey : event.ctrlKey)) { event.preventDefault(); activate('confirm'); }
}
const checkboxChecked = ref(false);
const presented = ref(false);
const closing = ref(false);
const resolvedPlacement = ref<BrowserOverlayPlacement>('bottom-end');
let offConfig: (() => void) | null = null;
let offShown: (() => void) | null = null;
let offHide: (() => void) | null = null;
let shownFrame = 0;
let shownPayload: BrowserOverlayShown | null = null;
let hideTimer = 0;
let hideSurface: HTMLElement | null = null;
let hideListener: ((event: TransitionEvent) => void) | null = null;

const menuUsesIconGutter = computed(
  () =>
    config.value?.kind === 'menu' &&
    config.value.items.some(
      (item) => (item.kind === 'item' || item.kind === 'zoom') && item.icon !== undefined,
    ),
);

const menuStyle = computed<Record<string, string>>(() => {
  const placement = resolvedPlacement.value;
  const opensUp = placement.startsWith('top-');
  const alignEnd = placement.endsWith('-end');
  return {
    width: config.value?.kind === 'menu' && config.value.autoWidth ? 'max-content' : `${config.value?.kind === 'menu' ? config.value.width ?? 220 : 220}px`,
    maxWidth: config.value?.kind === 'menu' ? `${config.value.width ?? 220}px` : '',
    minWidth: config.value?.kind === 'menu' ? `${config.value.minWidth ?? 180}px` : '',
    maxHeight: config.value?.kind === 'menu' && config.value.maxHeight !== undefined ? `${config.value.maxHeight}px` : '',
    transformOrigin: `${opensUp ? 'bottom' : 'top'} ${alignEnd ? 'right' : 'left'}`,
    '--browser-overlay-pop-shift': opensUp ? '2px' : '-2px',
  };
});

const modelMenuPositionStyle = computed((): Record<string, string> => ({
  position: 'absolute',
  left: `${modelMenuOffset.value?.x ?? BROWSER_OVERLAY_GUTTER}px`,
  top: `${modelMenuOffset.value?.y ?? BROWSER_OVERLAY_GUTTER}px`,
}));

const stageStyle = computed((): Record<string, string> => {
  const current = config.value;
  if (current?.kind === 'menu' && current.modelMenu !== undefined) return { padding: '0px' };
  if (current?.kind === 'menu') return { padding: `${BROWSER_OVERLAY_GUTTER}px` };
  if (current?.kind !== 'dialog') return {};
  return {
    '--browser-popover-max-width': `${Math.max(1, (current.boundary?.width ?? current.viewport?.width ?? 720) - BROWSER_OVERLAY_GUTTER * 2)}px`,
    '--browser-popover-max-height': `${Math.max(1, (current.boundary?.height ?? current.viewport?.height ?? 720) - BROWSER_OVERLAY_GUTTER * 2)}px`,
    '--browser-overlay-gutter': `${BROWSER_OVERLAY_GUTTER}px`,
    '--annotation-offset-x': `${Math.max(0, (current.anchor?.x ?? 0) - (current.boundary?.x ?? 0) - BROWSER_OVERLAY_GUTTER)}px`,
    '--annotation-offset-y': `${Math.max(0, (current.anchor?.y ?? 0) - (current.boundary?.y ?? 0) + (current.anchor?.height ?? 0) + 4 - BROWSER_OVERLAY_GUTTER)}px`,
  };
});

function enabledItems(): HTMLElement[] {
  return Array.from(
    menuRef.value?.el?.querySelectorAll<HTMLElement>(
      '.ui-menu-item:not(:disabled), .browser-overlay-zoom-control:not(:disabled), .overlay-menu-choices button:not(:disabled), .overlay-menu-actions button:not(:disabled)',
    ) ?? [],
  );
}

function menuItemKey(item: BrowserOverlayMenuItem, index: number): string {
  return item.kind === 'separator' ? `separator-${index}` : item.id;
}

function surfaceElement(): HTMLElement | null {
  if (config.value?.kind === 'dialog') return stageRef.value;
  if (config.value?.modelMenu !== undefined) return modelMenuRef.value?.el ?? null;
  return menuRef.value?.el ?? null;
}

function measuredCard(): HTMLElement | null {
  if (config.value?.kind === 'dialog') return dialogRef.value;
  if (config.value?.modelMenu !== undefined) return modelMenuRef.value?.el ?? null;
  return menuRef.value?.el ?? null;
}

function cancelShownFrame(): void {
  window.cancelAnimationFrame(shownFrame);
  shownFrame = 0;
}

function cancelPendingHide(): void {
  window.clearTimeout(hideTimer);
  hideTimer = 0;
  if (hideSurface !== null && hideListener !== null) {
    hideSurface.removeEventListener('transitionend', hideListener);
  }
  hideSurface = null;
  hideListener = null;
}

function applyConfig(next: BrowserOverlayConfig): void {
  const previous = config.value;
  if (next.kind === 'dialog' && (previous?.kind !== 'dialog' || previous.dialogId !== next.dialogId || previous.input?.value !== next.input?.value)) inputValue.value = next.input?.value ?? '';
  if (next.kind === 'dialog' && (previous?.kind !== 'dialog' || previous.dialogId !== next.dialogId || previous.checkbox?.checked !== next.checkbox?.checked)) checkboxChecked.value = next.checkbox?.checked ?? false;
  cancelPendingHide();
  const updating =
    config.value?.requestId === next.requestId && config.value.kind === next.kind;
  if (!updating) {
    cancelShownFrame();
    shownPayload = null;
    presented.value = false;
    closing.value = false;
  }
  if (next.kind === 'menu') resolvedPlacement.value = next.placement ?? 'bottom-end';
  reducedMotion.value = next.kind === 'dialog' && next.agent !== undefined && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  config.value = next;
  void nextTick(() => {
    reportSize();
    if (config.value?.kind === 'menu' && config.value.preserveFocus) revealBrowserMenuSelection(menuRef.value?.el);
  });
  if (updating && !presented.value && !closing.value && shownFrame === 0 && shownPayload?.requestId === next.requestId) show(shownPayload);

}

let sizeObserver: ResizeObserver | null = null;
let lastSize = '';
function reportSize(): void {
  const current = config.value;
  const card = measuredCard();
  if (current === null || card === null || closing.value) return;
  const { width, height } = measureBrowserOverlayCard(card);
  const anchor = current.anchor === undefined ? '' : [current.anchor.x, current.anchor.y, current.anchor.width, current.anchor.height].join(':');
  const sizeKey = current.kind === 'dialog' && current.annotation ? 'annotation' : `${width}:${height}`;
  const key = `${current.requestId}:${sizeKey}:${anchor}:${current.kind === 'dialog' ? JSON.stringify(current.boundary) : ''}`;
  if (width <= 0 || height <= 0 || lastSize === key) return;
  lastSize = key;
  bridge?.rendered({ requestId: current.requestId, width, height });
}

watch([menuRef, modelMenuRef, dialogRef], () => {
  sizeObserver?.disconnect();
  const card = measuredCard();
  if (card !== null) {
    sizeObserver = new ResizeObserver(reportSize);
    sizeObserver.observe(card);
    void document.fonts?.ready.then(reportSize);
  }
}, { flush: 'post' });

function show(payload: BrowserOverlayShown): void {
  const current = config.value;
  if (current === null || current.requestId !== payload.requestId) return;
  if (current.kind === 'menu' && payload.placement !== undefined) {
    resolvedPlacement.value = payload.placement;
  }
  if (current.kind === 'menu' && payload.menuOffset !== undefined) {
    modelMenuOffset.value = payload.menuOffset;
  }
  if (current.kind === 'menu' && payload.menuFrame !== undefined) {
    modelMenuFrame.value = payload.menuFrame;
  }
  const entering = !presented.value;
  closing.value = false;
  shownPayload = payload;
  window.cancelAnimationFrame(shownFrame);
  shownFrame = window.requestAnimationFrame(() => {
    shownFrame = 0;
    if (config.value?.requestId !== payload.requestId) return;
    presented.value = true;
    if (config.value.kind === 'menu' && config.value.modelMenu !== undefined) {
      if (entering) modelMenuRef.value?.el?.focus();
    } else if (config.value.kind === 'menu') {
      if (config.value.preserveFocus) revealBrowserMenuSelection(menuRef.value?.el);
      if (entering && config.value.initialFocus === 'first-item') enabledItems()[0]?.focus();
    } else if (!config.value.preserveFocus && (entering || config.value.anchor === undefined)) {
      const target = dialogRef.value
        ?.querySelector<HTMLElement>(
          config.value.input && !config.value.input.readOnly
            ? 'textarea, input.ui-input'
            : config.value.initialFocus === 'cancel'
              ? '.browser-overlay-dialog__cancel:not(:disabled)'
              : '.browser-overlay-dialog__confirm:not(:disabled)',
        );
      target?.focus();
      if (target instanceof HTMLInputElement) target.select();
    }
  });
}

function completeHide(requestId: number): void {
  if (config.value?.requestId !== requestId) return;
  cancelShownFrame();
  cancelPendingHide();
  shownPayload = null;
  config.value = null;
  presented.value = false;
  closing.value = false;
  bridge?.hidden({ requestId });
}

function hide(payload: BrowserOverlayVisibilityRequest): void {
  if (config.value?.requestId !== payload.requestId) return;
  cancelShownFrame();
  shownPayload = null;
  closing.value = true;
  presented.value = false;
  void nextTick(() => {
    if (config.value?.requestId !== payload.requestId) return;
    const surface = surfaceElement();
    if (surface === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      completeHide(payload.requestId);
      return;
    }
    hideSurface = surface;
    hideListener = (event) => {
      if (event.target === surface && event.propertyName === 'opacity') {
        completeHide(payload.requestId);
      }
    };
    surface.addEventListener('transitionend', hideListener);
    hideTimer = window.setTimeout(() => completeHide(payload.requestId), 220);
  });
}

function activate(itemId: string): void {
  const current = config.value;
  if (current?.kind === 'dialog' && (current.input || current.checkbox) && (itemId === 'confirm' || itemId === 'cancel' || itemId === 'auxiliary')) {
    bridge?.submitForm({ requestId: current.requestId, action: itemId, value: inputValue.value, checked: current.checkbox === undefined ? undefined : checkboxChecked.value });
    return;
  }
  if (current !== null) bridge?.activate({ requestId: current.requestId, itemId });
}

function submitLine(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  activate('confirm');
}

function dismiss(reason: 'dismiss' | 'escape'): void {
  const current = config.value;
  if (current === null || (current.kind === 'dialog' && current.loading === true)) return;
  bridge?.dismiss({ requestId: current.requestId, reason });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  const current = config.value;
  if (current === null) return;
  if (current.kind === 'menu' && current.modelMenu !== undefined) return;
  if (current.kind === 'menu' && current.submitOnCtrlEnter === true && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    dismiss('dismiss');
    return;
  }
  if (event.key === 'Escape') {
    if (current.kind === 'dialog' && current.loading === true) return;
    event.preventDefault();
    if (current.kind === 'dialog' && current.input?.singleLine && current.dismissible === false) activate('cancel');
    else dismiss('escape');
    return;
  }
  if (current.kind === 'dialog') {
    const ownsKeyboard = !current.preserveFocus || (!current.annotation && document.hasFocus());
    if (event.key === 'Tab' && ownsKeyboard) {
      event.preventDefault();
      const items = Array.from(dialogRef.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(item => item.getClientRects().length > 0);
      if (items.length > 0) {
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      }
      return;
    }
    if (event.key !== 'Enter' || current.loading === true || !ownsKeyboard) return;
    const target = event.target;
    if (
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    event.preventDefault();
    activate('confirm');
    return;
  }
  const items = enabledItems();
  const next = menuNavigationIndex(event.key, event.shiftKey, items.indexOf(document.activeElement as HTMLElement), items.length);
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

onMounted(() => {
  offConfig = bridge?.onConfig(applyConfig) ?? null;
  offShown = bridge?.onShown(show) ?? null;
  offHide = bridge?.onHide(hide) ?? null;
  bridge?.ready();
  window.addEventListener('keydown', onKeydown, true);
});

onUnmounted(() => {
  sizeObserver?.disconnect();
  cancelShownFrame();
  cancelPendingHide();
  offConfig?.();
  offConfig = null;
  offShown?.();
  offShown = null;
  offHide?.();
  offHide = null;
  window.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <main
    ref="stageRef"
    class="browser-overlay-stage"
    :class="{
      'is-dialog': config?.kind === 'dialog',
      'is-popover': config?.kind === 'dialog' && config.anchor !== undefined,
      'is-annotation-popover': config?.kind === 'dialog' && config.anchor !== undefined && config.annotation !== undefined,
      'is-presented': presented,
      'is-closing': closing,
    }"
    :style="stageStyle"
    @mousedown.self="dismiss('dismiss')"
  >
    <ModelQuickMenu
      v-if="config?.kind === 'menu' && config.modelMenu !== undefined"
      ref="modelMenuRef"
      class="browser-overlay-menu browser-overlay-model-menu"
      :class="{ 'is-presented': presented, 'is-closing': closing }"
      :style="modelMenuPositionStyle"
      :models="config.modelMenu.models"
      :recent-models="config.modelMenu.recentModels"
      :provider-models="config.modelMenu.providerModels"
      :providers="config.modelMenu.providers"
      :active-provider="config.modelMenu.activeProvider"
      :active-provider-label="config.modelMenu.activeProviderLabel"
      :current-model-id="config.modelMenu.currentModelId"
      :current-effort="config.modelMenu.currentEffort"
      :effort-descriptions="config.modelMenu.effortDescriptions"
      :max-height="config.maxHeight ?? 480"
      :host-frame="modelMenuFrame ?? undefined"
      @select-model="(modelId, effort) => config?.kind === 'menu' && bridge?.activate({ requestId: config.requestId, itemId: 'model-menu', modelAction: { type: 'select-model', modelId, ...(effort === undefined ? {} : { effort }) } satisfies QuickModelMenuAction })"
      @select-effort="(effort) => config?.kind === 'menu' && bridge?.activate({ requestId: config.requestId, itemId: 'model-menu', modelAction: { type: 'select-effort', effort } satisfies QuickModelMenuAction })"
      @select-provider="(providerId) => config?.kind === 'menu' && bridge?.activate({ requestId: config.requestId, itemId: 'model-menu', modelAction: { type: 'select-provider', providerId } satisfies QuickModelMenuAction })"
      @dismiss="dismiss('escape')"
    />
    <Menu
      v-else-if="config?.kind === 'menu'"
      ref="menuRef"
      :role="config.preserveFocus ? 'listbox' : 'menu'"
      class="browser-overlay-menu"
      :class="{
        'is-presented': presented,
        'is-closing': closing,
        'has-icon-gutter': menuUsesIconGutter,
      }"
      :style="menuStyle"
    >
      <div class="browser-overlay-list">
        <BrowserOverlayMenuEntry v-for="(item, index) in config.items.slice(0, config.footerStart ?? config.items.length)" :key="menuItemKey(item, index)" :item="item" :listbox="config.preserveFocus" :icon-gutter="menuUsesIconGutter" :highlight-query="config.query" @action="activate" />
      </div>
      <div v-if="config.footerStart !== undefined" class="browser-overlay-footer">
        <BrowserOverlayMenuEntry v-for="(item, index) in config.items.slice(config.footerStart)" :key="menuItemKey(item, index)" :item="item" :listbox="config.preserveFocus" :icon-gutter="menuUsesIconGutter" :highlight-query="config.query" @action="activate" />
      </div>
    </Menu>

    <section
      v-else-if="config?.kind === 'dialog'"
      ref="dialogRef"
      class="browser-overlay-dialog"
      :class="{ 'is-annotation': config.annotation, 'is-agent': config.agent, 'is-reduced-motion': reducedMotion }"
      role="dialog"
      :aria-modal="config.anchor === undefined && !config.boundary"
      :aria-label="config.title"
      tabindex="-1"
    >
      <header class="browser-overlay-dialog__head">
        <span v-if="config.annotation" class="annotation-number">{{ config.annotation.capture.ordinal }}</span>
        <h2>{{ config.annotation ? config.annotation.labels.annotation : config.title }}</h2>
        <span v-if="config.annotation" class="annotation-tag">{{ config.annotation.capture.target.kind === 'element' ? config.annotation.capture.target.tagName : 'region' }}</span>
        <IconButton
          v-if="config.dismissible !== false"
          size="sm"
          :label="config.closeLabel"
          :tooltip="config.closeLabel"
          :disabled="config.loading"
          @click="activate('cancel')"
        >
          <Icon name="close" size="md" />
        </IconButton>
      </header>
      <div v-if="config.agent" class="browser-overlay-dialog__agent">
        <Tooltip :text="config.agent.hint" placement="bottom">
          <Badge class="browser-overlay-dialog__agent-tab" role="note" :aria-label="`${config.agent.label}. ${config.agent.hint}`" :title="config.agent.hint"><Icon name="robot" size="sm" />{{ config.agent.label }}</Badge>
        </Tooltip>
      </div>
      <AnnotationScroll v-if="config.annotation" class="annotation-body">
        <AnnotationDetails :key="config.annotation.capture.id" :details="config.annotation" :read-only="config.input?.readOnly" @insert="insertClass" />
        <p v-if="config.message" class="annotation-status">{{ config.message }}</p>
        <div class="annotation-comment-row"><label for="annotation-comment">{{ config.input?.label }}</label><div v-if="config.checkbox" class="annotation-switch"><span>{{ config.checkbox.label }}</span><Switch v-model="checkboxChecked" :label="config.checkbox.label" :disabled="config.loading || config.checkbox.disabled" /></div></div>
        <Textarea v-if="config.input" id="annotation-comment" ref="annotationInput" v-model="inputValue" size="sm" :rows="2" autosize :resize="false" :placeholder="config.input.placeholder" :readonly="config.input.readOnly" :disabled="config.loading" :maxlength="10000" @keydown="annotationKeydown" />
      </AnnotationScroll>
      <div v-else class="browser-overlay-dialog__body">
        <p v-if="config.message" :id="config.files ? 'browser-overlay-dialog-files-label' : undefined">{{ config.message }}</p>
        <ul v-if="config.files" class="browser-overlay-dialog__files" role="list" tabindex="0" aria-labelledby="browser-overlay-dialog-files-label">
          <li v-for="(path, index) in config.files" :key="index">{{ path }}</li>
        </ul>
        <img v-if="config.preview" class="browser-overlay-dialog__preview" :src="config.preview.src" :alt="config.preview.alt" @load="reportSize" />
        <Checkbox v-if="config.checkbox" v-model="checkboxChecked" :disabled="config.loading || config.checkbox.disabled">{{ config.checkbox.label }}</Checkbox>
        <Input v-if="config.input?.singleLine" v-model="inputValue" class="browser-overlay-dialog__line" :size="config.anchor ? 'sm' : 'md'" :aria-label="config.input.label" :placeholder="config.input.placeholder" :readonly="config.input.readOnly" :disabled="config.loading" :maxlength="10000" @keydown.enter="submitLine" />
        <label v-else-if="config.input" class="browser-overlay-dialog__input">
          <span>{{ config.input.label }}</span>
          <Textarea v-model="inputValue" :size="config.anchor ? 'sm' : 'md'" :rows="config.anchor ? 2 : 3" :placeholder="config.input.placeholder" :readonly="config.input.readOnly" :disabled="config.loading" :maxlength="10000" :resize="false" @keydown.meta.enter.prevent="activate('confirm')" @keydown.ctrl.enter.prevent="activate('confirm')" />
        </label>
      </div>
      <footer class="browser-overlay-dialog__foot">
        <Button v-if="config.auxiliary" :size="config.anchor ? 'sm' : 'md'" variant="ghost" :disabled="config.loading || config.auxiliary.disabled" @click="activate('auxiliary')">{{ config.auxiliary.label }}</Button>
        <Button v-if="!config.singleAction" class="browser-overlay-dialog__cancel" :size="config.anchor ? 'sm' : 'md'" variant="secondary" :disabled="config.loading" @click="activate('cancel')">
          {{ config.cancelLabel }}
        </Button>
        <Button
          class="browser-overlay-dialog__confirm"
          :size="config.anchor ? 'sm' : 'md'"
          :variant="config.annotation ? 'primary' : config.variant ?? 'danger'"
          :loading="config.loading"
          @click="activate('confirm')"
        >
          {{ config.confirmLabel }}
          <Kbd v-if="config.annotation && !config.input?.readOnly" :keys="['mod', 'enter']" variant="button" />
        </Button>
      </footer>
    </section>
  </main>
</template>

<style scoped>
.panel-menu-icon-space {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  flex: none;
}
:global(html),
:global(body),
:global(#app) {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: clip;
  background: transparent !important;
}

.browser-overlay-stage {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  background: transparent;
  overflow: clip;
}

.browser-overlay-list { min-height: 0; overflow-y: auto; overflow-x: hidden; }
.browser-overlay-footer { flex: none; }
.browser-overlay-list :deep(.ui-menu-item:focus-visible) { box-shadow: inset var(--p-focus-ring); }

.browser-overlay-menu {
  user-select: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  opacity: 0;
  transform: scale(0.97) translateY(var(--browser-overlay-pop-shift, -2px));
  pointer-events: none;
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}

.browser-overlay-menu.is-presented {
  opacity: 1;
  transform: scale(1) translateY(0);
  pointer-events: auto;
}

.browser-overlay-menu.is-closing {
  transition-duration: var(--duration-fast);
}
.browser-overlay-model-menu {
  overflow: visible;
  transform-origin: bottom right;
}

.browser-overlay-stage.is-dialog {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  background: rgba(13, 17, 23, 0.28);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-base) var(--ease-out);
}

.browser-overlay-stage.is-popover {
  align-items: flex-start;
  justify-content: flex-start;
  padding: var(--browser-overlay-gutter);
  background: transparent;
}
.browser-overlay-stage.is-popover .browser-overlay-dialog {
  width: min(var(--browser-annotation-popover-width), var(--browser-popover-max-width), 100%);
  max-height: var(--browser-popover-max-height);
  box-shadow: var(--shadow-menu);
}
.browser-overlay-stage.is-annotation-popover { flex-direction: column; }
.browser-overlay-stage.is-annotation-popover::before { content: ''; flex: 0 1 var(--annotation-offset-y); min-height: 0; }
.is-annotation-popover > .browser-overlay-dialog { flex-shrink: 0; margin-left: min(var(--annotation-offset-x), max(0px, calc(100% - var(--browser-annotation-popover-width)))); }
.is-popover .browser-overlay-dialog__head { align-items: center; padding: var(--space-3) var(--space-3) var(--space-1); }
.is-popover .browser-overlay-dialog__head h2 { font-size: var(--text-sm); }
.is-popover .browser-overlay-dialog__body { padding: 0 var(--space-3); gap: var(--space-2); font-size: var(--text-sm); }
.is-popover .browser-overlay-dialog__body p { font-size: var(--text-xs); overflow-wrap: anywhere; }
.is-popover .browser-overlay-dialog__input { gap: var(--space-1); }
.is-popover .browser-overlay-dialog__foot { padding: var(--space-3); gap: var(--space-2); }

.browser-overlay-stage.is-dialog.is-presented {
  opacity: 1;
  pointer-events: auto;
}

.browser-overlay-stage.is-dialog.is-closing {
  transition-duration: var(--duration-fast);
}

.browser-overlay-dialog {
  width: min(440px, 100%);
  max-height: calc(100vh - var(--space-8) * 2);
  display: flex;
  flex-direction: column;
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  outline: none;
  overflow: hidden;
  transform: scale(0.98) translateY(2px);
  transition: transform var(--duration-slow) var(--ease-out);
}

.is-presented > .browser-overlay-dialog {
  transform: scale(1) translateY(0);
}

.browser-overlay-dialog__head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 20px 22px 14px;
}

.browser-overlay-dialog.is-agent {
  position: relative;
  overflow: visible;
  border: var(--browser-control-edge) solid var(--color-accent);
  box-shadow: var(--shadow-xl), var(--browser-agent-dialog-halo-rest);
  animation: browser-agent-dialog-breathe var(--browser-agent-dialog-breathe-duration) var(--ease-in-out) infinite alternate;
}

.browser-overlay-dialog.is-agent.is-reduced-motion {
  animation: none;
  box-shadow: var(--shadow-xl), var(--browser-agent-dialog-halo-peak);
}

@keyframes browser-agent-dialog-breathe {
  from { box-shadow: var(--shadow-xl), var(--browser-agent-dialog-halo-rest); }
  to { box-shadow: var(--shadow-xl), var(--browser-agent-dialog-halo-peak); }
}

.browser-overlay-dialog__agent {
  position: absolute;
  top: calc(var(--browser-control-edge) * -1);
  right: var(--browser-agent-dialog-tab-inset);
  z-index: 1;
  display: flex;
  transform: translateY(-50%);
}

.browser-overlay-dialog__agent .browser-overlay-dialog__agent-tab {
  gap: var(--space-1);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-accent);
  color: var(--color-accent);
}

.is-agent .browser-overlay-dialog__head {
  padding-top: var(--space-6);
}

.browser-overlay-dialog__head h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-size: var(--text-lg);
  font-weight: 500;
  color: var(--color-text);
  line-height: var(--leading-tight);
}

.browser-overlay-dialog__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  flex: 1;
  min-height: 0;
  padding: 4px 22px 18px;
  color: var(--color-text);
  overflow: auto;
}

.browser-overlay-dialog__preview {
  max-width: 100%;
  width: auto;
  align-self: center;
  max-height: var(--browser-annotation-preview-max-height);
  object-fit: contain;
  border-radius: var(--radius-md);
}
.browser-overlay-dialog__input {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.browser-overlay-dialog__body p {
  margin: 0;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.browser-overlay-dialog__files {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 0 1 auto;
  min-height: 0;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  list-style: none;
  overflow-y: auto;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.browser-overlay-dialog__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 22px 20px;
}

.browser-overlay-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-overlay-icon-slot {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.browser-overlay-shortcut {
  flex: none;
  margin-left: auto;
  padding-left: var(--space-4);
}

@media (prefers-reduced-motion: reduce) {
  .browser-overlay-menu,
  .browser-overlay-stage.is-dialog,
  .browser-overlay-dialog {
    transition-duration: 0.01ms;
  }
}
.annotation-number { flex: none; width: 1.3rem; height: 1.3rem; border-radius: var(--radius-full); display: grid; place-items: center; background: var(--color-accent); color: var(--color-text-on-accent); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.annotation-tag { padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); background: var(--color-accent-soft); color: var(--color-accent); font: var(--text-xs) var(--font-mono); }
.annotation-body { flex: 1; min-height: 0; padding-inline: var(--space-3); }
.annotation-comment-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); border-top: var(--p-hairline) solid var(--color-line); margin-top: var(--space-1); padding-block: var(--space-2); }
.annotation-comment-row > label { font-size: var(--text-sm); font-weight: var(--weight-section-label); }
.annotation-switch { display: flex; align-items: center; gap: var(--space-1); font-size: var(--text-xs); line-height: 1.25rem; color: var(--color-text-muted); }
.annotation-switch > span { display: flex; align-items: center; min-height: 1.25rem; }
.annotation-status { font-size: var(--text-xs); color: var(--color-text-muted); }
.is-annotation .browser-overlay-dialog__head { user-select: none; }
.is-annotation .browser-overlay-dialog__head h2 { font-weight: var(--weight-section-label); }
.is-annotation .browser-overlay-dialog__confirm { padding-right: var(--space-2); }
</style>
