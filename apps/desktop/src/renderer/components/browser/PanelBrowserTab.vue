<script setup lang="ts">
import { useBrowserPermissionDialog } from '../../lib/browserPermissions';
import { browserPageDialogPreemptsPermission, browserPageDialogs, useBrowserPageDialog } from '../../lib/browserPageDialogs';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useComposerBrowserReferenceHost } from '@moonshot-ai/app-components';
import { Banner, Button, EmptyState, Icon, IconButton, Input, ProgressBar } from '@moonshot-ai/app-ui';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { asBrowserBounds, EMPTY_BROWSER_STATE, type BrowserBounds, type BrowserState } from '../../../shared/browser';
import { browserDeviceViewBounds, type BrowserDeviceModeRequest } from '../../../shared/browser-device';
import { createBrowserFocusRequest } from '../../lib/browserFocusRequest';
import { registerBrowserOverlayMenu } from '../../lib/browserOverlayMenu';
import { getNativeBrowserBridge } from '../../lib/nativeBrowser';
import { hasBrowserSeeThrough, setBrowserSeeThrough } from '../../lib/browserSeeThrough';
import type { BrowserSettingsSection } from '../../../shared/browser-data';
import BrowserViewportResize from './BrowserViewportResize.vue';
import BrowserDeviceToolbar from './BrowserDeviceToolbar.vue';
import BrowserAddressBar from './BrowserAddressBar.vue';
import BrowserSiteInfo from './BrowserSiteInfo.vue';
import BrowserDownloadButton from './BrowserDownloadButton.vue';

const deviceBackground = ref('auto');
try { const saved = localStorage.getItem('kimi-web.browser-device-background'); if (saved === 'auto' || /^#[0-9a-f]{6}$/i.test(saved ?? '')) deviceBackground.value = saved!; } catch {}
function setDeviceBackground(value: string): void {
  if (value !== 'auto' && !/^#[0-9a-f]{6}$/i.test(value)) return;
  deviceBackground.value = value;
  try { localStorage.setItem('kimi-web.browser-device-background', value); } catch {}
}

const annotationHost = useComposerBrowserReferenceHost();
const annotationPicking = computed(() => annotationHost?.isPicking(props.browserId) ?? false);
const props = defineProps<{
  browserId: string;
  active: boolean;


  occluded: boolean;
}>();
const emit = defineEmits<{
  titleChange: [title: string];
  stateChange: [state: BrowserState];
  faviconChange: [favicon: string | undefined];
  loadingChange: [loading: boolean];
  openSettings: [section: BrowserSettingsSection];
}>();

const EMPTY_TAB_ITEMS = [
  { key: 'browse', icon: 'globe' },
  { key: 'read', icon: 'file-text' },
  { key: 'interact', icon: 'pointer' },
  { key: 'layout', icon: 'device-desktop' },
  { key: 'recall', icon: 'history' },
] as const;

const { t, locale } = useI18n();
const { confirm } = useConfirmDialog();
const bridge = getNativeBrowserBridge();

const state = ref<BrowserState>({ ...EMPTY_BROWSER_STATE });
const address = ref('');
const addressFocused = ref(false);
const localError = ref<string | null>(null);
let occlusionSent = false;
let pendingLowers = 0;
let unmounted = false;
const viewportEl = ref<HTMLElement | null>(null);
const syncPermissionDialog = useBrowserPermissionDialog(props.browserId, () => props.active && !props.occluded, viewportEl, t, () => locale.value, () => browserPageDialogPreemptsPermission(browserPageDialogs.value, props.browserId));
const syncPageDialog = useBrowserPageDialog(props.browserId, () => props.active && !props.occluded, viewportEl, t);
const addressInput = ref<InstanceType<typeof BrowserAddressBar> | null>(null);
const menuButton = ref<InstanceType<typeof IconButton> | null>(null);
const findInput = ref<InstanceType<typeof Input> | null>(null);
const findOpen = ref(false);
const findQuery = ref('');

let resizeObserver: ResizeObserver | null = null;
let offState: (() => void) | null = null;
let boundsFrame: number | null = null;
let deviceUpdateChain = Promise.resolve();

const browserMenu = registerBrowserOverlayMenu({
  id: `browser.toolbar.${props.browserId}`,
  width: 240,
  autoWidth: true,
  placement: 'bottom-end',
  offset: 4,
  items: () => {
    const pageUnavailable = state.value.url === '';
    const zoomFactor = state.value.zoomFactor ?? 1;
    return [
      {
        kind: 'item',
        id: 'find',
        label: t('browser.menu.findInPage'),
        icon: 'search',
        disabled: pageUnavailable,
      },
      {
        kind: 'item',
        id: 'print',
        label: t('browser.menu.print'),
        icon: 'printer',
        disabled: pageUnavailable,
      },
      { kind: 'separator' },
      {
        kind: 'zoom',
        id: 'zoom',
        label: t('browser.menu.zoom'),
        icon: 'zoom-scan',
        value: `${Math.round(zoomFactor * 100)}%`,
        decreaseAction: 'zoom-out',
        decreaseLabel: t('browser.menu.zoomOut'),
        increaseAction: 'zoom-in',
        increaseLabel: t('browser.menu.zoomIn'),
        resetAction: 'zoom-reset',
        resetLabel: t('browser.menu.zoomReset'),
        decreaseDisabled: pageUnavailable || zoomFactor <= 0.25,
        increaseDisabled: pageUnavailable || zoomFactor >= 5,
        resetDisabled: pageUnavailable || Math.abs(zoomFactor - 1) < 0.001,
      },
      { kind: 'separator' },
      {
        kind: 'item',
        id: 'device-mode',
        label: t(
          state.value.device
            ? 'browser.menu.hideDeviceToolbar'
            : 'browser.menu.showDeviceToolbar',
        ),
        icon: 'device-desktop',
        selected: state.value.device !== undefined,
        disabled: pageUnavailable,
      },
      {
        kind: 'item',
        id: 'emulate-focus', label: t('browser.menu.emulateFocus'), icon: 'eye', selected: state.value.emulateFocus === true, disabled: pageUnavailable,
      },
      {
        kind: 'item',
        id: 'screenshot',
        label: t('browser.menu.screenshot'),
        icon: 'screenshot',
        disabled: pageUnavailable,
      },
      { kind: 'separator' },
      {
        kind: 'item',
        id: 'downloads',
        label: t('browser.downloads.title'),
        icon: 'download',
      },
      { kind: 'item', id: 'history', label: t('browser.history.title'), icon: 'history' },
      {
        kind: 'item',
        id: 'clear-data',
        label: t('browser.clearData'),
        icon: 'trash',
      },
      { kind: 'separator' },
      {
        kind: 'item',
        id: 'settings',
        label: t('browser.settings.title'),
        icon: 'settings',
      },
    ];
  },
  onSelect: (itemId) => {
    void runBrowserMenuAction(itemId).catch((error: unknown) => {
      localError.value = error instanceof Error ? error.message : String(error);
    });
  },
});

function adoptState(next: BrowserState): void {
  emit('stateChange', next);
  state.value = next;
  syncSeeThrough();
  localError.value = null;
  if (!addressFocused.value) address.value = next.url;
  emit('titleChange', next.title);
  emit('faviconChange', next.favicon);
  emit('loadingChange', next.loading);
}

function pageShown(): boolean {
  return props.active && document.visibilityState !== 'hidden';
}

function viewportBounds(el: HTMLElement): BrowserBounds | null {
  const rect = el.getBoundingClientRect();
  const inset = state.value.device?.profileId === 'responsive' ? parseFloat(getComputedStyle(el).getPropertyValue('--space-6')) || 24 : 0;
  return asBrowserBounds({
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(0, rect.width - inset * 2),
    height: Math.max(0, rect.height - inset * 2),
  });
}

function syncSeeThrough(): void {
  const el = viewportEl.value;
  const bounds = el === null ? null : viewportBounds(el);
  if (unmounted || bridge === null || bounds === null || !pageShown() || state.value.renderable !== true || state.value.error !== undefined) {
    if (unmounted || pendingLowers === 0) setBrowserSeeThrough(props.browserId, null);
    return;
  }
  setBrowserSeeThrough(props.browserId, browserDeviceViewBounds(bounds, state.value.device));
}

function syncBoundsNow(): void {
  const el = viewportEl.value;
  if (bridge === null || el === null) return;
  syncPermissionDialog();
  syncPageDialog();
  syncSeeThrough();
  const bounds = viewportBounds(el);
  if (bounds !== null) bridge.browserSetBounds(props.browserId, bounds);
}

function reportBounds(): void {
  if (boundsFrame !== null) cancelAnimationFrame(boundsFrame);
  boundsFrame = requestAnimationFrame(() => {
    boundsFrame = null;
    syncBoundsNow();
  });
}

function setOccluded(occluded: boolean): void {
  if (bridge === null || occlusionSent === occluded) return;
  occlusionSent = occluded;
  const sent = bridge.browserSetOccluded(props.browserId, occluded).catch(() => {});
  if (occluded) return;
  pendingLowers++;
  void sent.then(() => {
    pendingLowers--;
    syncSeeThrough();
  });
}

function syncVisibility(): void {
  if (bridge === null) return;
  const shown = pageShown();
  bridge.browserSetVisible(props.browserId, shown);
  const holePainted = hasBrowserSeeThrough(props.browserId);
  if (!props.occluded) setOccluded(false);
  syncSeeThrough();
  if (shown && props.occluded) {
    if (holePainted || !hasBrowserSeeThrough(props.browserId)) setOccluded(true);
    else requestAnimationFrame(() => requestAnimationFrame(() => { if (!unmounted && pageShown() && props.occluded) setOccluded(true); }));
  }
  if (shown) void nextTick(reportBounds);
}

async function navigate(): Promise<void> {
  if (bridge === null || address.value.trim() === '') return;
  localError.value = null;
  try {
    adoptState(await bridge.browserNavigate(props.browserId, address.value));
  } catch {
    localError.value = t('browser.invalidAddress');
  }
}

async function goBack(): Promise<void> {
  if (bridge !== null) adoptState(await bridge.browserBack(props.browserId));
}

async function goForward(): Promise<void> {
  if (bridge !== null) adoptState(await bridge.browserForward(props.browserId));
}

async function reload(): Promise<void> {
  if (bridge !== null) adoptState(await bridge.browserReload(props.browserId));
}

async function runBrowserMenuAction(itemId: string): Promise<void> {
  if (bridge === null) return;
  if (itemId === 'emulate-focus') {
    adoptState(await bridge.browserSetFocusEmulation(props.browserId, !state.value.emulateFocus));
  } else if (itemId === 'find') {
    findOpen.value = true;
    await nextTick();
    findInput.value?.focus();
    findInput.value?.select();
    if (findQuery.value !== '') await runFind(true, false);
  } else if (itemId === 'print') {
    await bridge.browserPrint(props.browserId);
  } else if (itemId === 'zoom-out') {
    adoptState(await bridge.browserZoom(props.browserId, 'out'));
    browserMenu.refresh();
  } else if (itemId === 'zoom-reset') {
    adoptState(await bridge.browserZoom(props.browserId, 'reset'));
    browserMenu.refresh();
  } else if (itemId === 'zoom-in') {
    adoptState(await bridge.browserZoom(props.browserId, 'in'));
    browserMenu.refresh();
  } else if (itemId === 'device-mode') {
    await updateDeviceMode(
      state.value.device === undefined
        ? {
            enabled: true,
            profileId: 'responsive',
            orientation: 'portrait',
            width: 393,
            height: 852,
            scaleMode: 'fit',
          }
        : { enabled: false },
    );
  } else if (itemId === 'screenshot') {
    await bridge.browserCaptureScreenshot(props.browserId);
  } else if (itemId === 'clear-data') {
    await requestClearData();
  } else if (itemId === 'downloads' || itemId === 'history' || itemId === 'settings') {
    emit('openSettings', itemId);
  }
}

function updateDeviceMode(request: BrowserDeviceModeRequest): Promise<void> {
  if (bridge === null) return Promise.resolve();
  const task = deviceUpdateChain.then(async () => {
    adoptState(await bridge.browserSetDeviceMode(props.browserId, request));
  });
  deviceUpdateChain = task.catch((error: unknown) => {
    console.error('Failed to update Browser device emulation', error);
  });
  return task;
}

const canOpenInDefaultBrowser = computed(() => /^https?:\/\//i.test(state.value.url));

async function openInDefaultBrowser(): Promise<void> {
  if (bridge === null || !canOpenInDefaultBrowser.value) return;
  localError.value = null;
  try {
    await bridge.browserTabCommand({ browserId: props.browserId, action: 'open-external' });
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  }
}

async function toggleAnnotation(): Promise<void> {
  if (annotationPicking.value) { annotationHost?.cancelPick(props.browserId); return; }
  await annotationHost?.beginPick(props.browserId);
}

function toggleBrowserMenu(event: MouseEvent): void {
  event.stopPropagation();
  const trigger = menuButton.value?.el;
  if (trigger !== undefined) browserMenu.toggle(trigger);
}

async function runFind(forward: boolean, findNext: boolean): Promise<void> {
  if (bridge === null || findQuery.value === '') return;
  await bridge.browserFind(props.browserId, findQuery.value, { forward, findNext });
}

function closeFind(): void {
  findOpen.value = false;
  void bridge?.browserStopFind(props.browserId);
}

watch(findQuery, (query) => {
  if (!findOpen.value || bridge === null) return;
  if (query === '') void bridge.browserStopFind(props.browserId);
  else void runFind(true, false);
});

async function retry(): Promise<void> {
  if (state.value.url !== '') address.value = state.value.url;
  await navigate();
}

async function requestClearData(): Promise<void> {
  if (bridge === null) return;
  await confirm({
    title: t('browser.clearDataTitle'),
    message: t('browser.clearDataMessage'),
    confirmLabel: t('browser.clearDataConfirm'),
    cancelLabel: t('common.cancel'),
    variant: 'danger',
    action: async () => {
      adoptState(await bridge.browserClearData(props.browserId));
      address.value = '';
    },
  });
}

function onAddressFocus(): void {
  addressFocused.value = true;
  addressInput.value?.select();
}

function onAddressBlur(): void {
  addressFocused.value = false;
  if (state.value.url !== '') address.value = state.value.url;
}

const addressFocusRequest = createBrowserFocusRequest();

async function focusAddress(): Promise<void> {
  await addressFocusRequest.run(async () => bridge?.browserFocusChrome(), () => {
    addressInput.value?.focus();
    addressInput.value?.select();
  }, () => props.active && !props.occluded);
}

async function navigateTo(url: string): Promise<void> {
  address.value = url;
  await navigate();
}

defineExpose({ focusAddress, navigateTo, reload, syncBoundsNow });

watch(
  () => [props.active, props.occluded] as const,
  () => syncVisibility(),
  { flush: 'post' },
);

watch(
  () => props.active,
  (active) => {
    if (!active) { addressFocusRequest.cancel(); browserMenu.close(); annotationHost?.cancelPick(props.browserId); }
  },
);

watch(() => state.value.device?.profileId === 'responsive', () => void nextTick(reportBounds));

onMounted(() => {
  if (bridge === null) return;
  let receivedState = false;
  offState = bridge.onBrowserState((browserId, next) => {
    if (browserId === props.browserId) { receivedState = true; adoptState(next); }
  });
  void bridge.getBrowserState(props.browserId).then(next => { if (!receivedState && offState) adoptState(next); });
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(reportBounds);
    if (viewportEl.value !== null) resizeObserver.observe(viewportEl.value);
  }
  window.addEventListener('resize', reportBounds);
  document.addEventListener('visibilitychange', syncVisibility);
  reportBounds();
  syncVisibility();
});

onUnmounted(() => {
  unmounted = true;
  setBrowserSeeThrough(props.browserId, null);
  setOccluded(false);
  addressFocusRequest.cancel();
  annotationHost?.cancelPick(props.browserId);
  if (findOpen.value) void bridge?.browserStopFind(props.browserId);
  bridge?.browserSetVisible(props.browserId, false);
  offState?.();
  offState = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('resize', reportBounds);
  document.removeEventListener('visibilitychange', syncVisibility);
  if (boundsFrame !== null) cancelAnimationFrame(boundsFrame);
  boundsFrame = null;
});
</script>

<template>
  <section class="panel-browser" :data-browser-id="browserId" :aria-label="t('browser.ariaLabel')">
    <form class="pb-toolbar" @submit.prevent="navigate">
      <div class="pb-navigation" role="group" :aria-label="t('browser.navigationAria')">
        <IconButton
          size="sm"
          :label="t('browser.back')"
          :tooltip="t('browser.back')"
          :disabled="!state.canGoBack"
          @click="goBack"
        >
          <Icon name="arrow-left" />
        </IconButton>
        <IconButton
          size="sm"
          :label="t('browser.forward')"
          :tooltip="t('browser.forward')"
          :disabled="!state.canGoForward"
          @click="goForward"
        >
          <Icon name="arrow-right" />
        </IconButton>
        <IconButton
          size="sm"
          :label="t('browser.reload')"
          :tooltip="t('browser.reload')"
          :disabled="state.url === ''"
          @click="reload"
        >
          <Icon name="refresh" />
        </IconButton>
      </div>
      <BrowserAddressBar ref="addressInput" v-model="address" :url="state.url" class="pb-address" @navigate="navigate" @focus="onAddressFocus" @blur="onAddressBlur"><template #site><BrowserSiteInfo :url="state.url" @open-settings="emit('openSettings', 'sites')" /></template></BrowserAddressBar>
      <BrowserDownloadButton :browser-id="browserId" :active="active && !occluded" @open-all="emit('openSettings', 'downloads')" />
      <IconButton size="sm" :label="t('browser.openInDefaultBrowser')" :tooltip="t('browser.openInDefaultBrowser')" :disabled="!canOpenInDefaultBrowser" @click="openInDefaultBrowser">
        <Icon name="external-link" />
      </IconButton>
      <IconButton v-if="annotationHost" size="sm" :label="t(annotationPicking ? 'browserReference.cancelPick' : 'browserReference.title')" :tooltip="t(annotationPicking ? 'browserReference.cancelPick' : 'browserReference.title')" :pressed="annotationPicking" :disabled="state.url === ''" @click="toggleAnnotation">
        <Icon name="crosshair" />
      </IconButton>
      <IconButton
        ref="menuButton"
        size="sm"
        :label="t('browser.menuButton')"
        :tooltip="t('browser.menuButton')"
        aria-haspopup="menu"
        :aria-expanded="browserMenu.open.value"
        @click="toggleBrowserMenu"
      >
        <Icon name="dots-horizontal" />
      </IconButton>
      <ProgressBar v-if="state.loading" class="pb-loading" :label="t('common.loading')" />
    </form>

    <Banner v-if="localError !== null" class="pb-operation-error" variant="danger" role="alert">
      {{ localError }}
    </Banner>

    <form v-if="findOpen" class="pb-find" @submit.prevent="runFind(true, true)">
      <Input
        ref="findInput"
        v-model="findQuery"
        class="pb-find-input"
        size="sm"
        type="search"
        autocomplete="off"
        :placeholder="t('browser.find.placeholder')"
        :aria-label="t('browser.find.placeholder')"
        @keydown.shift.enter.prevent="runFind(false, true)"
      />
      <IconButton
        size="sm"
        :label="t('browser.find.previous')"
        :tooltip="t('browser.find.previous')"
        :disabled="findQuery === ''"
        @click="runFind(false, true)"
      >
        <Icon name="arrow-up" />
      </IconButton>
      <IconButton
        size="sm"
        :label="t('browser.find.next')"
        :tooltip="t('browser.find.next')"
        :disabled="findQuery === ''"
        @click="runFind(true, true)"
      >
        <Icon name="arrow-down" />
      </IconButton>
      <IconButton
        size="sm"
        :label="t('browser.find.close')"
        :tooltip="t('browser.find.close')"
        @click="closeFind"
      >
        <Icon name="close" />
      </IconButton>
    </form>

    <BrowserDeviceToolbar
      v-if="state.device"
      :browser-id="browserId"
      :device="state.device"
      :background="deviceBackground"
      @background-change="setDeviceBackground"
      :update-device-mode="updateDeviceMode"
    />

    <div ref="viewportEl" class="pb-viewport" :style="state.device && deviceBackground !== 'auto' ? { backgroundColor: deviceBackground } : undefined" :class="{ 'is-device': state.device }">
      <BrowserViewportResize v-if="active && !occluded && state.device?.profileId === 'responsive'" :device="state.device" :resize="updateDeviceMode" />
      <div v-if="bridge === null" class="pb-message" role="status">
        <p>{{ t('browser.unavailable') }}</p>
      </div>
      <div v-else-if="state.error" class="pb-message" role="alert">
        <p class="pb-error-title">{{ t('browser.loadFailed') }}</p>
        <p class="pb-error-detail">{{ state.error }}</p>
        <Button size="sm" variant="secondary" @click="retry">{{ t('browser.retry') }}</Button>
      </div>
      <div v-else-if="state.url === ''" class="pb-empty">
        <EmptyState class="pb-empty-state" size="lg" :title="t('browser.empty.title')">
          <p class="pb-empty-lead">{{ t('browser.empty.lead') }}</p>
          <ul class="pb-empty-list">
            <li v-for="item in EMPTY_TAB_ITEMS" :key="item.key">
              <span class="pb-empty-icon"><Icon :name="item.icon" /></span>
              <div>
                <p class="pb-empty-label">{{ t(`browser.empty.items.${item.key}.label`) }}</p>
                <p class="pb-empty-detail">{{ t(`browser.empty.items.${item.key}.detail`) }}</p>
              </div>
            </li>
          </ul>
          <p class="pb-empty-footnote">{{ t('browser.empty.footnote') }}</p>
        </EmptyState>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel-browser {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--color-bg);
}

.pb-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  min-width: 0;
  padding: var(--space-2);
  border-bottom: var(--p-hairline) solid var(--color-line);
  -webkit-app-region: no-drag;
}

.pb-loading {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  pointer-events: none;
}

.pb-navigation {
  display: flex;
  align-items: center;
  gap: var(--space-05);
  flex: none;
}

.pb-operation-error {
  flex: none;
  margin: var(--space-2);
  overflow-wrap: anywhere;
}

.pb-find {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
  min-width: 0;
  min-height: 40px;
  padding: var(--space-2);
  border-bottom: var(--p-hairline) solid var(--color-line);
  background: var(--color-bg);
  -webkit-app-region: no-drag;
}

.pb-find-input {
  flex: 1;
  min-width: 0;
  box-shadow: none;
}

.pb-address {
  flex: 1;
  min-width: 0;
  box-shadow: none;
}


.pb-viewport {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg);
}

.pb-viewport.is-device {
  background: var(--color-surface-sunken);
}

.pb-message {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.pb-message p {
  max-width: 440px;
  margin: 0;
}

.pb-error-title {
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

.pb-error-detail {
  color: var(--color-text-faint);
  overflow-wrap: anywhere;
}

.pb-empty {
  position: absolute;
  inset: 0;
  display: flex;
  overflow: auto;
  container-type: size;
  user-select: none;
  cursor: default;
}

.pb-empty-state {
  width: 100%;
  max-width: 420px;
  margin: auto;
}

.pb-empty-lead,
.pb-empty-list,
.pb-empty-footnote {
  line-height: var(--leading-normal);
}

.pb-empty-lead,
.pb-empty-list {
  font-size: var(--text-sm);
}

.pb-empty-lead,
.pb-empty-footnote {
  margin: 0;
  text-wrap: balance;
}

.pb-empty-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3) var(--space-6);
  width: 100%;
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  text-align: left;
}

.pb-empty-list li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
}

.pb-empty-list p {
  margin: 0;
}

.pb-empty-icon {
  display: flex;
  flex: none;
  align-items: center;
  height: calc(var(--text-sm) * var(--leading-normal));
}

.pb-empty-label {
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

.pb-empty-footnote {
  padding-top: var(--space-2);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}

@container (min-width: 640px) {
  .pb-empty-state {
    max-width: 600px;
  }

  .pb-empty-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@container (max-width: 340px) or (max-height: 460px) {
  .pb-empty-list {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2) var(--space-4);
  }

  .pb-empty-list li {
    align-items: center;
    gap: var(--space-1);
  }

  .pb-empty-detail {
    display: none;
  }
}

@container (max-height: 300px) {
  .pb-empty-footnote {
    display: none;
  }
}

@container (max-height: 180px) {
  .pb-empty-lead,
  .pb-empty-list {
    display: none;
  }
}
</style>
