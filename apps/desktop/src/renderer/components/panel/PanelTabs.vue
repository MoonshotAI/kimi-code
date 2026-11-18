<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfirmDialog, useIsMobile, usePanelSlide } from '@moonshot-ai/app-client/composables';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import type { useFilePreview, usePanelTabs } from '@moonshot-ai/app-client/composables';
import type { FilePreviewRequest } from '@moonshot-ai/app-core/client';
import { hasDesktopBridge } from '@moonshot-ai/app-core/lib';
import { ResizeHandle, useFileStaleness } from '@moonshot-ai/app-components';
import { useNativeTerminal } from '../../composables/useNativeTerminal';
import { createTerminalCloseGuard } from '../../lib/terminalCloseGuard';
import { focusAfterTabClose } from './tabCloseFocus';
import PanelTabBar from './PanelTabBar.vue';
import PanelLauncher from './PanelLauncher.vue';
import PanelTermTab from '../terminal/PanelTermTab.vue';
import PanelBrowserTab from '../browser/PanelBrowserTab.vue';
import type {
  BrowserTabPayload,
  PanelLauncherType,
  TermTabPayload,
  TurnDiffTabPayload,
} from '@moonshot-ai/app-client/panel';
import { isTraceEnabled } from '@moonshot-ai/app-client/trace';
import { panelCloseTargets, type PanelCloseAction } from '@moonshot-ai/app-client/panel';
import type { SelectionActionPayload } from '@moonshot-ai/app-client/lib';
import { panelComponents } from './panelComponents';
import { panelTabProps, type PanelAdapterCtx } from './panelAdapters';
import type { OpenMediaRequest } from '../../types';
import { getNativeBrowserBridge } from '../../lib/nativeBrowser';
import { registerBrowserOverlayDialog } from '../../lib/browserOverlayDialog';
import type { BrowserTabAction } from '../../lib/browserTabMenu';
import { warningsStore } from '@moonshot-ai/app-client/stores';
import { createBrowserId, type BrowserState } from '../../../shared/browser';
import { clonedBrowserTabPayload } from '../../lib/browserTabClone';
import type { BrowserSettingsSection } from '../../../shared/browser-data';

const props = defineProps<{
  panel: ReturnType<typeof usePanelTabs>;
  sidebarCollapsed: boolean;
  filePreview: ReturnType<typeof useFilePreview>;
  openFile?: (target: FilePreviewRequest) => void;
  onOpenMedia: (payload: OpenMediaRequest) => void;
  onOpenBtw: () => Promise<unknown> | void;
  onOpenTerm: () => Promise<unknown> | void;
  canOpenTerm: boolean;
  canOpenBrowser: boolean;
  browserOccluded: boolean;
  onQuoteAction: (payload: SelectionActionPayload) => void;
}>();
const emit = defineEmits<{
  openBrowserSettings: [section: BrowserSettingsSection];
}>();

const { t } = useI18n();
const isMobile = useIsMobile();
const rootEl = ref<HTMLElement | null>(null);
const shellEl = ref<HTMLElement | null>(null);
const slideEnabled = computed(() => !isMobile.value && !props.panel.panelExpanded.value && !props.panel.panelDragging.value);
const { contentVisible, sliding, onTransitionEnd } = usePanelSlide({
  visible: props.panel.panelVisible,
  enabled: slideEnabled,
  element: rootEl,
  onGeometryChange: syncActiveBrowserBounds,
});
const { sliding: sidebarSliding } = usePanelSlide({
  visible: computed(() => !props.sidebarCollapsed),
  enabled: slideEnabled,
  element: rootEl,
  onGeometryChange: syncActiveBrowserBounds,
});
const client = useKimiWebClient();
const terminalStore = useNativeTerminal();
const desktopBridge = hasDesktopBridge();
const presentedTabs = computed(() => props.panel.panelTabs.value.filter(tab => {
  return desktopBridge || (tab.type !== 'browser' && tab.type !== 'term');
}).map(tab => {
  if (tab.type !== 'term') return tab;
  const payload = tab.payload as TermTabPayload | undefined;
  const terminal = terminalStore.allTabs.value.find(item => item.id === payload?.ptyId);
  const binary = terminal?.binary ?? terminal?.shell ?? payload?.title;
  return binary ? { ...tab, title: binary } : tab;
}));
const { confirm } = useConfirmDialog();
function moveTerminalToBottom(tabId: string, index: number): void {
  const tab = props.panel.panelTabs.value.find(item => item.id === tabId);
  const ptyId = tab?.type === 'term' ? (tab.payload as TermTabPayload | undefined)?.ptyId : undefined;
  if (ptyId !== undefined && terminalStore.moveTabToBottom(ptyId, index) !== null) props.panel.closeTab(tabId, { keepVisible: true });
}
const approveClose = createTerminalCloseGuard({ inspect: ids => terminalStore.inspect(ids), confirm, t });
async function requestClose(action: PanelCloseAction, id?: string): Promise<void> {
  const targets = panelCloseTargets(presentedTabs.value, action, id);
  if (targets.length === 0) return;
  const session = client.activeSessionId.value;
  const workspace = client.activeWorkspaceId.value;
  const approved = await approveClose(targets.map(tab => ({
    id: tab.id, title: tab.presentation?.title ?? tab.title,
    ptyId: tab.type === 'term' ? (tab.payload as TermTabPayload | undefined)?.ptyId : undefined,
  })));
  if (!approved || session !== client.activeSessionId.value || workspace !== client.activeWorkspaceId.value) return;
  for (const tab of targets) {
    if (props.panel.panelTabs.value.some(current => current.id === tab.id && current.payload === tab.payload)) props.panel.closeTab(tab.id);
  }
  focusAfterTabClose();
}

const staleness = useFileStaleness({ turns: client.turns, sessionId: client.activeSessionId, cwd: computed(() => client.status.value.cwd) });

const previewTracker = staleness.createTracker('preview', () => {
  const target = props.filePreview.previewTarget.value;
  if (!target || typeof target.content === 'string') return [];
  return [
    props.filePreview.previewAbsolutePath.value,
    props.filePreview.previewNormalizedPath.value,
    target.path,
  ];
});
let previewStartMarkers: ReadonlyMap<string, string> | undefined;
watch(props.filePreview.previewLoadStartedSeq, () => {
  previewStartMarkers = staleness.markers.value;
});
watch(props.filePreview.previewLoadedSeq, () => previewTracker.markLoaded(previewStartMarkers));
watch(
  () => props.filePreview.previewTarget.value,
  (target) => {
    if (target && typeof target.content === 'string') previewTracker.markLoaded();
  },
);

const diffTracker = staleness.createTracker('diff', () => {
  const rel = client.selectedDiffPath.value;
  if (!rel) return [];
  const cwd = client.selectedDiffRoot.value ?? client.status.value.cwd;
  return [rel, cwd ? (/[/\\]$/.test(cwd) ? `${cwd}${rel}` : `${cwd}/${rel}`) : null];
});
let diffStartMarkers: ReadonlyMap<string, string> | undefined;
watch(
  () => client.fileDiffLoadStartedSeq.value,
  () => { diffStartMarkers = staleness.markers.value; },
);
watch(
  () => client.fileDiffLoadedSeq.value,
  () => diffTracker.markLoaded(diffStartMarkers),
);
if (client.selectedDiffPath.value) void client.loadFileDiff(client.selectedDiffPath.value, { preserveCurrent: true, root: client.selectedDiffRoot.value });

const adapterCtx: PanelAdapterCtx = {
  panel: props.panel,
  client,
  filePreview: props.filePreview,
  previewStale: previewTracker.stale,
  diffStale: diffTracker.stale,
  onOpenMedia: props.onOpenMedia,
  openFile: (target) => (props.openFile ?? props.panel.openFilePreview)(target),
};

const activeBinding = computed(() => {
  if (!contentVisible.value) return null;
  const tab = props.panel.activeTab.value;
  if (
    !tab ||
    tab.type === 'term' ||
    tab.type === 'browser'
  ) {
    return null;
  }
  const component = panelComponents[tab.type];
  if (!component) return null;
  const bindings = panelTabProps(tab, adapterCtx);
  if (!bindings) return null;
  const key =
    tab.type === 'turn-diff' && tab.payload !== undefined
      ? `${tab.id}:${(tab.payload as TurnDiffTabPayload).turnId}:${(tab.payload as TurnDiffTabPayload).change.path}`
      : tab.id;
  return { tabId: tab.id, key, component, props: bindings, cached: tab.type === 'agent' };
});

const termBindings = computed(() =>
  props.panel.panelTabs.value
    .filter((tab) => tab.type === 'term')
    .map((tab) => {
      const payload = (tab.payload ?? {}) as TermTabPayload;
      return { tabId: tab.id, ptyId: payload.ptyId ?? null, error: payload.error ?? null };
    }),
);

const browserBindings = computed(() =>
  props.panel.panelTabs.value
    .filter((tab) => tab.type === 'browser' && tab.payload !== undefined)
    .map((tab) => ({
      tabId: tab.id,
      browserId: (tab.payload as BrowserTabPayload).browserId,
    })),
);
const browserStates = ref<Record<string, BrowserState>>({});
watch(browserBindings, bindings => {
  const ids = new Set(bindings.map(binding => binding.tabId));
  browserStates.value = Object.fromEntries(Object.entries(browserStates.value).filter(([id]) => ids.has(id)));
});
function onBrowserStateChange(tabId: string, state: BrowserState): void {
  browserStates.value[tabId] = state;
}
let renameTabId: string | null = null;
const renameDialog = registerBrowserOverlayDialog({
  id: 'browser.tab.rename',
  onConfirm: value => {
    if (renameTabId !== null) props.panel.renameBrowserTab(renameTabId, value ?? '');
    renameTabId = null;
    renameDialog.close();
  },
  onCancel: () => { renameTabId = null; renameDialog.close(); },
});
onUnmounted(() => renameDialog.dispose());
type BrowserPanelInstance = InstanceType<typeof PanelBrowserTab>;
const browserPanelRefs = new Map<string, BrowserPanelInstance>();
function setBrowserPanelRef(tabId: string, instance: unknown): void {
  if (instance === null) browserPanelRefs.delete(tabId);
  else browserPanelRefs.set(tabId, instance as BrowserPanelInstance);
}
function browserActive(tabId: string): boolean {
  return contentVisible.value && tabId === props.panel.activeTabId.value;
}

async function openBrowserUrl(url: string): Promise<void> {
  const tab = props.panel.openTab('browser', {
    browserId: createBrowserId(),
  } satisfies BrowserTabPayload);
  await nextTick();
  await browserPanelRefs.get(tab.id)?.navigateTo(url);
}

function focusPanelTab(tabId: string): void {
  document
    .querySelector<HTMLElement>(`.ptb-tab-main[data-tab-id="${CSS.escape(tabId)}"]`)
    ?.focus();
}

function onBrowserTabAction(tabId: string, action: BrowserTabAction): void {
  void runBrowserTabAction(tabId, action).catch(error => warningsStore().pushOperationFailure('browser-tab-action', error, { title: t('browser.tabMenu.actionFailed') }));
}

async function runBrowserTabAction(tabId: string, action: BrowserTabAction): Promise<void> {
  const source = props.panel.panelTabs.value.find(tab => tab.id === tabId && tab.type === 'browser');
  if (!source?.payload) return;
  if ((action === 'new-right' || action === 'duplicate') && !props.canOpenBrowser) return;
  const payload = source.payload as BrowserTabPayload;
  if (action === 'new-right') {
    const tab = props.panel.openTab('browser', { browserId: createBrowserId() } satisfies BrowserTabPayload);
    props.panel.moveTabAfter(tab.id, tabId);
    await nextTick();
    await browserPanelRefs.get(tab.id)?.focusAddress();
    return;
  }
  if (action === 'duplicate') {
    const bridge = getNativeBrowserBridge();
    if (bridge === null) return;
    const session = client.activeSessionId.value, workspace = client.activeWorkspaceId.value;
    const interaction = props.panel.panelInteractionVersion.value;
    const browserId = createBrowserId();
    const state = await bridge.browserClone(payload.browserId, browserId);
    if (client.activeSessionId.value !== session || client.activeWorkspaceId.value !== workspace || !props.panel.panelTabs.value.some(tab => tab.id === tabId)) {
      bridge.browserClose(browserId);
      return;
    }
    const copy: BrowserTabPayload = clonedBrowserTabPayload(payload, browserId, state);
    const tab = interaction === props.panel.panelInteractionVersion.value ? props.panel.openTab('browser', copy) : props.panel.addTabInBackground('browser', copy);
    props.panel.moveTabAfter(tab.id, tabId);
    browserStates.value[tab.id] = state;
    return;
  }
  if (action === 'rename') {
    renameTabId = tabId;
    renameDialog.show({ title: t('browser.tabMenu.rename'), confirmLabel: t('browser.tabMenu.saveName'), cancelLabel: t('common.cancel'), closeLabel: t('common.close'), variant: 'primary', input: { label: t('browser.tabMenu.tabName'), value: payload.customTitle ?? source.title, placeholder: t('browser.tabMenu.automaticName') } });
    return;
  }
  if (action === 'copy-url' || action === 'open-external' || action === 'mute' || action === 'unmute') {
    const state = await getNativeBrowserBridge()?.browserTabCommand({ browserId: payload.browserId, action });
    if (state && props.panel.panelTabs.value.some(tab => tab.id === tabId)) browserStates.value[tabId] = state;
    return;
  }
  if (action === 'fork') {
    const sessionId = client.activeSessionId.value;
    if (sessionId !== null) {
      props.panel.activateTab(tabId);
      await client.forkSession(sessionId);
    }
    return;
  }
  if (action === 'reload') {
    await browserPanelRefs.get(tabId)?.reload();
    return;
  }
  if (action === 'close') {
    props.panel.closeTab(tabId);
    focusAfterTabClose();
    return;
  }
  await requestClose(action === 'close-others' ? 'others' : 'right', tabId);
  await nextTick();
  focusPanelTab(tabId);
}

watch(
  () => [props.panel.activeTab.value, contentVisible.value] as const,
  ([tab, visible]) => {
    if (visible && tab?.type === 'file' && tab.payload !== undefined) {
      void props.filePreview.openFilePreview(tab.payload as FilePreviewRequest);
    } else {
      props.filePreview.closeFilePreview();
    }
  },
  { immediate: true },
);

watch(
  () => isTraceEnabled() ? null : props.panel.panelTabs.value.find((tab) => tab.type === 'inspector')?.id,
  (id) => {
    if (id !== null && id !== undefined) props.panel.closeTab(id);
  },
  { immediate: true },
);

async function onAddTab(type: PanelLauncherType): Promise<void> {
  const launcherHadFocus =
    document.activeElement instanceof HTMLElement &&
    document.activeElement.closest('.pl') !== null;
  const sessionAtCall = client.activeSessionId.value;
  const workspaceAtCall = client.activeWorkspaceId.value;
  if (type === 'browser') {
    const tab = props.panel.openTab('browser', {
      browserId: createBrowserId(),
    } satisfies BrowserTabPayload);
    await nextTick();
    await browserPanelRefs.get(tab.id)?.focusAddress();
    return;
  }
  let landed: Promise<unknown> | void = undefined;
  if (type === 'diff') props.panel.openDiffDetail();
  else if (type === 'files') props.panel.openFilesPanel();
  else if (type === 'inspector') props.panel.openTab('inspector');
  else if (type === 'term') landed = props.onOpenTerm();
  else landed = props.onOpenBtw();
  let acted = false;
  const onUserAction = (e: Event): void => {
    if (e instanceof KeyboardEvent && e.repeat) return;
    acted = true;
    props.panel.bumpInteractionVersion();
    disarm();
  };
  const disarm = (): void => {
    document.removeEventListener('pointerdown', onUserAction, true);
    document.removeEventListener('keydown', onUserAction, true);
    window.removeEventListener('blur', onUserAction);
    document.removeEventListener('visibilitychange', onUserAction);
  };
  if (type !== 'diff' && type !== 'files' && type !== 'inspector') {
    document.addEventListener('pointerdown', onUserAction, true);
    document.addEventListener('keydown', onUserAction, true);
    window.addEventListener('blur', onUserAction);
    document.addEventListener('visibilitychange', onUserAction);
  }
  try {
    const result = (await landed) as { sessionId?: string | null } | undefined;
    if (acted) return;
    if (!launcherHadFocus) return;
    if (type === 'btw') {
      if (result?.sessionId != null && result.sessionId !== client.activeSessionId.value) return;
    } else if (
      client.activeSessionId.value !== sessionAtCall ||
      (sessionAtCall === null && client.activeWorkspaceId.value !== workspaceAtCall)
    ) {
      return;
    }
    if (!props.panel.panelVisible.value || props.panel.activeTabId.value === null) return;
    await nextTick();
    if (type === 'btw') {
      focusSideChatInput();
      return;
    }
    document.querySelector<HTMLElement>('.ptb-tab.on .ptb-tab-main')?.focus();
  } finally {
    disarm();
  }
}

function activatePanelTab(id: string): void {
  props.panel.activateTab(id);
}

const activePanelRef = ref<{
  focusInput?: () => void;
} | null>(null);
function focusSideChatInput(): void {
  activePanelRef.value?.focusInput?.();
}


async function browserShortcut(action: 'reload' | 'new-tab' | 'focus-address'): Promise<boolean> {
  if (!props.canOpenBrowser || isMobile.value) return false;
  if (action === 'new-tab') { await onAddTab('browser'); return true; }
  const active = props.panel.activeTab.value;
  if (!props.panel.panelVisible.value || active?.type !== 'browser') return false;
  const browser = browserPanelRefs.get(active.id);
  if (browser === undefined) return true;
  if (action === 'reload') await browser.reload();
  else await browser.focusAddress();
  return true;
}

const pfcHostEl = ref<HTMLElement | null>(null);
defineExpose({ focusSideChatInput, openBrowserUrl, browserShortcut, openLauncherTab: onAddTab, rootEl, pfcHostEl });
const pfcHostH = ref(0);
let pfcHostRO: ResizeObserver | null = null;
watch(pfcHostEl, (el, prev) => {
  pfcHostRO?.disconnect();
  pfcHostRO = null;
  if (el !== null && typeof ResizeObserver !== 'undefined') {
    pfcHostRO = new ResizeObserver(() => {
      pfcHostH.value = el.offsetHeight;
    });
    pfcHostRO.observe(el);
  }
  pfcHostH.value = el?.offsetHeight ?? 0;
});
onUnmounted(() => pfcHostRO?.disconnect());
function syncActiveBrowserBounds(): void {
  const activeId = props.panel.activeTabId.value;
  if (activeId !== null) browserPanelRefs.get(activeId)?.syncBoundsNow();
}
function setPreviewWidth(width: number): void {
  rootEl.value?.style.setProperty('--preview-w', `${width}px`);
  shellEl.value?.style.setProperty('--preview-w', `${width}px`);
}
function applyPreviewWidthLive(width: number): void {
  setPreviewWidth(width);
  syncActiveBrowserBounds();
}
watch(
  [rootEl, shellEl, () => props.panel.previewPanelWidth.value],
  ([, , w]) => {
    setPreviewWidth(w);
    void nextTick(syncActiveBrowserBounds);
  },
  { immediate: true },
);
</script>

<template>
  <aside
    ref="rootEl"
    class="global-preview"
    :class="{ open: panel.panelVisible.value, mobile: isMobile, expanded: panel.panelExpanded.value, sliding, 'sidebar-sliding': sidebarSliding }"
    @transitionend="onTransitionEnd"
    role="complementary"
    :aria-label="t('layout.detailPanelAria')"
    :aria-hidden="!panel.panelVisible.value"
    :inert="!panel.panelVisible.value"
  >
    <ResizeHandle
      v-if="panel.panelVisible.value && !isMobile && !panel.panelExpanded.value"
      class="panel-resize"
      :storage-key="panel.PREVIEW_WIDTH_KEY"
      :default-width="panel.previewDefaultWidth.value"
      :min="panel.PREVIEW_MIN"
      :max="panel.previewMax.value"
      reverse
      :aria-label="t('layout.resizePreviewAria')"
      :apply-live="applyPreviewWidthLive"
      @update:width="panel.previewWidth.value = $event"
      @update:dragging="panel.panelDragging.value = $event"
    />
    <div ref="shellEl" class="pt-shell" :style="{ '--pfc-host-h': `${pfcHostH}px` }">
      <PanelTabBar
        :tabs="presentedTabs"
        :active-tab-id="panel.activeTabId.value"
        :revealed-tab-id="panel.revealedTabId.value"
        :expanded="panel.panelExpanded.value"
        :visible="panel.panelVisible.value"
        :can-expand="!isMobile && props.panel.panelCanExpand.value"
        :can-open-diff="Boolean(client.activeSessionId.value)"
        :can-open-files="Boolean(client.activeWorkspaceId.value)"
        :can-open-term="canOpenTerm"
        :can-open-browser="canOpenBrowser"
        :can-fork-browser="Boolean(client.activeSessionId.value)"
        :browser-states="browserStates"
        :can-open-btw="Boolean(client.activeSessionId.value)"
        @activate="activatePanelTab"
        @move="panel.moveTab"
        @move-to-bottom="moveTerminalToBottom"
        @close="requestClose('close', $event)"
        @close-others="requestClose('others', $event)"
        @close-to-right="requestClose('right', $event)"
        @close-all="requestClose('all')"
        @add="onAddTab"
        @browser-tab-action="onBrowserTabAction"
        @toggle-expanded="panel.toggleExpanded()"
        @hide="panel.hidePanel()"
      />
      <div class="pt-body">
        <PanelBrowserTab
          v-for="binding in browserBindings"
          @state-change="state => onBrowserStateChange(binding.tabId, state)"
          v-show="browserActive(binding.tabId)"
          :key="binding.tabId"
          :ref="(instance) => setBrowserPanelRef(binding.tabId, instance)"
          :browser-id="binding.browserId"
          :active="browserActive(binding.tabId)"
          :occluded="browserOccluded"
          @title-change="panel.updateBrowserTabTitle(binding.tabId, $event)"
          @favicon-change="panel.updateBrowserTabFavicon(binding.tabId, $event)"
          @loading-change="panel.updateBrowserTabLoading(binding.tabId, $event)"
          @open-settings="emit('openBrowserSettings', $event)"
        />
        <PanelTermTab
          v-for="binding in termBindings"
          v-show="contentVisible && binding.tabId === panel.activeTabId.value"
          :key="binding.tabId"
          :pty-id="binding.ptyId"
          :error="binding.error"
          :active="panel.panelVisible.value && binding.tabId === panel.activeTabId.value"
          @quote-action="onQuoteAction"
        />
        <KeepAlive :max="6">
          <component
            :is="activeBinding.component"
            v-if="activeBinding?.cached"
            :key="activeBinding.key"
            ref="activePanelRef"
            v-bind="activeBinding.props"
          />
        </KeepAlive>
        <component
          :is="activeBinding.component"
          v-if="activeBinding && !activeBinding.cached"
          :key="activeBinding.key"
          ref="activePanelRef"
          v-bind="activeBinding.props"
        />
        <PanelLauncher
          v-if="!activeBinding && panel.panelTabs.value.length === 0"
          :can-open-diff="Boolean(client.activeSessionId.value)"
          :can-open-files="Boolean(client.activeWorkspaceId.value)"
          :can-open-term="canOpenTerm"
          :can-open-browser="canOpenBrowser"
          :can-open-btw="Boolean(client.activeSessionId.value)"
          @open="onAddTab"
        />
      </div>
      <div ref="pfcHostEl" class="pfc-host" />
    </div>
  </aside>
</template>

<style scoped>
@property --preview-w {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

.global-preview {
  --preview-w: var(--panel-default-w);
  grid-column: 4;
  grid-row: 1 / -1;
  min-width: 0;
  min-height: 0;
  width: 0;
  background: var(--bg);
  overflow: hidden;
  position: relative;
}
.global-preview.sliding {
  transition: width var(--duration-slow) var(--ease-in-out);
}
.global-preview.sidebar-sliding,
.global-preview.sidebar-sliding .pt-shell {
  transition: var(--side-width-anim);
}
.global-preview.open {
  width: var(--preview-w);
}
.global-preview.open:not(.mobile):not(.expanded) {
  overflow: visible;
}
.global-preview.expanded {
  width: auto;
}
.global-preview.mobile {
  position: fixed;
  inset: 0;
  z-index: var(--z-sticky);
  width: auto;
  transition: none;
  border-top: var(--p-hairline) solid var(--color-text);
}
.global-preview.mobile:not(.open) {
  display: none;
}

.panel-resize {
  position: absolute;
  left: calc(-1 * var(--space-1));
  top: 0;
  bottom: 0;
  width: var(--space-1);
  margin: 0;
  -webkit-app-region: no-drag;
}
.panel-resize :deep(.rh-bar) {
  left: auto;
  right: 0;
  width: var(--space-05);
}

.pt-shell {
  --preview-w: var(--panel-default-w);
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  position: relative;
  overflow: hidden;
}
.global-preview:not(.mobile) .pt-shell {
  width: var(--preview-w);
  border-left: var(--p-hairline) solid var(--line);
}
.global-preview:not(.mobile).expanded .pt-shell {
  width: auto;
  border-left: none;
}
.pt-body {
  flex: 1;
  min-height: 0;
}
.pfc-host {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-sticky);
  width: 100%;
  max-width: var(--p-content-max);
  margin: 0 auto;
  box-sizing: border-box;
  padding: 0 var(--space-4) var(--space-4);
}
.pfc-host:empty {
  padding: 0;
}
.pt-body > * {
  height: 100%;
  box-sizing: border-box;
}
</style>
