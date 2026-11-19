<script setup lang="ts">
import { browserCommandTakesControl, createBrowserCommandGate, prepareBrowserExecution } from './lib/browserExecutionReadiness';
import { createBrowserUiCommandQueue, createBrowserUiRequestTracker } from './lib/browserUiCommandQueue';
import { observeBrowserPermissions } from './lib/browserPermissions';
import { browserApprovalBrowserIds, observeBrowserPageDialogs } from './lib/browserPageDialogs';
import { watchBrowserControlPresentation } from './lib/browserControlPresentation';
import { showBrowserTab, openBrowserLinkTab } from './lib/browserTabVisibility';
import { browserControlOutOfView, createBrowserLiveView } from './lib/browserLiveView';
import { browserFaviconSignature, createBrowserFaviconSource } from './lib/browserFavicons';
import { commandArgumentText, commandPromptContent, composerSnapshotFromMetadata } from '@moonshot-ai/app-client/lib';
import type { ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { BrowserFaviconSourceKey, BrowserLiveViewKey, BrowserReceiptReaderKey, ComposerBrowserReferenceHostKey, ComposerNativeMenuHostKey } from '@moonshot-ai/app-components';
import { registerBrowserOverlayMenu } from './lib/browserOverlayMenu';
import { createBrowserAnnotationHost } from './lib/browserAnnotationHost';
import type { BrowserAnnotationContextRequest } from '../shared/browser-annotation';
import { useMenuDragRegions } from './composables/useMenuDragRegions';
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch, watchEffect } from 'vue';
import { useTerminalActivity } from './composables/useTerminalActivity';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import Sidebar from './components/Sidebar.vue';
import { ResizeHandle } from '@moonshot-ai/app-components';
import ConversationPane from './components/chat/ConversationPane.vue';
import PanelTabs from './components/panel/PanelTabs.vue';
import { focusAfterTabClose, focusClosedPanelToggle } from './components/panel/tabCloseFocus';
import { SessionAdminView, useSessionAdminBatch } from '@moonshot-ai/app-components';
import { SelectionActionBubble } from '@moonshot-ai/app-components';
import { MediaLightbox } from '@moonshot-ai/app-components';
import { FileContextMenuHost } from '@moonshot-ai/app-components';
import { ModelPicker } from '@moonshot-ai/app-components';
import { ModelSwitchConfirmDialog } from '@moonshot-ai/app-components';
import LoginDialog from './components/dialogs/LoginDialog.vue';
import GlobalFeedbackDialog from './components/feedback/GlobalFeedbackDialog.vue';
import { DesktopFeedbackKey, useDesktopFeedback, type GlobalFeedbackTarget } from './composables/useDesktopFeedback';
import ScreenshotGuidanceDialog from './components/dialogs/ScreenshotGuidanceDialog.vue';
import ForcedUpgradeDialog from './components/ForcedUpgradeDialog.vue';
import { ErrorBoundary } from '@moonshot-ai/app-components';
import SettingsDialog from './components/settings/SettingsDialog.vue';
import { AddWorkspaceDialog, WorkspaceEditDialog } from '@moonshot-ai/app-components';
import { ConfirmDialogHost, PastedTextDialog, openPastedTextDialog, usePastedTextStats } from '@moonshot-ai/app-components';
import BrowserOverlayConfirmHost from './components/browser-overlay/BrowserOverlayConfirmHost.vue';
import { StatusPanel } from '@moonshot-ai/app-components';
import { MobileTopBar } from '@moonshot-ai/app-components';
import MobileSwitcherSheet from './components/mobile/MobileSwitcherSheet.vue';
import MobileSettingsSheet from './components/mobile/MobileSettingsSheet.vue';
import OnboardingWizard from './components/onboarding/OnboardingWizard.vue';
import { GlobalLoading } from '@moonshot-ai/app-components';
import { getDeviceApi, useKimiWebClient, promptAttachmentToTurnAttachment, turnFileContentFetcher } from '@moonshot-ai/app-client/client';
import { sessionViewsStore, workspacesStore, modelsStore, notificationsStore, authStore, sessionsStore, warningsStore, filesStore, permissionsStore, enableSessionRating, modelSwitchConfirmStore, hostsStore } from '@moonshot-ai/app-client/stores';
import { FetchTurnFileContentKey, InsertPathMentionKey, ModelDisplayKey, OpenWithDefaultAppKey, ResolveSwarmMembersKey, RevealInFolderKey, SelectionContextMenuKey, SessionRatingKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { OpenFileLinkKey, OpenHtmlFileInPanelKey, OpenLocalHtmlFileKey, OpenMarkdownImageKey, OpenSidebarBrowserUrlKey, ResolveImageKey } from '@moonshot-ai/app-core/contracts';
import { getKimiWebApi } from './api';
import { useConfirmDialog, useSelectionQuoteBubble } from '@moonshot-ai/app-client/composables';
import { runComposerMenuEdit } from '@moonshot-ai/app-composer/runtime';
import { startMentionTooltip } from '@moonshot-ai/app-composer/transcript';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { sweepPendingQuotes, captureQuoteSource, PANEL_QUOTE_CONTAINER, type SelectionActionPayload } from '@moonshot-ai/app-client/lib';
import type { ColorScheme, FontScale, PromptAttachment, ChatGateVerdict } from '@moonshot-ai/app-client/client';
import type { OpenMediaRequest, ToolMedia, TurnAttachment, WorkspaceView } from './types';
import { usePageTitle } from '@moonshot-ai/app-client/composables';
import { useSidebarLayout } from '@moonshot-ai/app-client/composables';
import { useFilePreview } from '@moonshot-ai/app-client/composables';
import { usePanelTabs } from '@moonshot-ai/app-client/composables';
import { panelApiKey, type PanelApi, type BrowserTabPayload, type BtwTabPayload, type CompactionTabPayload, type FileTabPayload, type PanelLauncherType, type TermTabPayload, type TurnDiffTabPayload, DRAFT_CONTEXT_KEY_PREFIX } from '@moonshot-ai/app-client/panel';
import { panelLauncherItems } from './lib/panelLauncher';
import { useIsMobile } from '@moonshot-ai/app-client/composables';
import { createAppViewportVarsWriter, installImeCompositionLatch, openFileAttachment, restoreSendDraftAtOrigin } from '@moonshot-ai/app-client/lib';
import type { FilePreviewRequest, SwarmMember } from '@moonshot-ai/app-core/client';
import { collectTurnAttachmentImages } from '@moonshot-ai/app-core/client';
import ServerAuthDialog from './components/ServerAuthDialog.vue';
import { getCredential, initServerAuth, onAuthRequired, pathRelativeTo } from '@moonshot-ai/app-core/lib';
import { clearEmbeddedServerCredential } from './lib/embeddedServerAuth';
import { pickWorkspaceDirectoryWithFallback } from './lib/nativeWorkspacePicker';
import type { AppConfig, OAuthRegion, ThinkingLevel } from './api/types';
import { effectiveThinkingLevel } from '@moonshot-ai/app-core/lib';
import { isPurePreviewFile, modelDisplayName, subagentEffortSuffix } from '@moonshot-ai/app-core/lib';
import { stripSkillPrefix, skillCommandArgs } from '@moonshot-ai/app-core/lib';
import { TOWER_STATUS_PROMPT, TOWER_TEARDOWN_PROMPT } from '@moonshot-ai/app-core/lib';
import { useContextInspector } from '@moonshot-ai/app-core';
import { sessionDisplayStatus, type SessionDisplayStatus } from '@moonshot-ai/app-core/lib';
import { Icon, IconButton, StatusDot } from '@moonshot-ai/app-ui';
import { hasCustomTitleBar, hasDesktopBridge, isMacosDesktop, isWindowsDesktop } from '@moonshot-ai/app-core/lib';
import CustomTitleBar from './components/window/CustomTitleBar.vue';
import TerminalDropZone from './components/terminal/TerminalDropZone.vue';
import TerminalPanel from './components/terminal/TerminalPanel.vue';
import TerminalResizeHandle from './components/terminal/TerminalResizeHandle.vue';
import { selectContentsOf } from '@moonshot-ai/app-core/lib';
import { useFullscreen } from './composables/useFullscreen';
import { useNativeTerminal, nativeTerminalDraftKey } from './composables/useNativeTerminal';
import { runWhenInitialized, useTrayAttention } from './composables/useTrayAttention';
import { useJumpList } from './composables/useJumpList';
import { useVibrancy } from './composables/useVibrancy';
import { useQuitConfirm } from './composables/useQuitConfirm';
import {
  canUseNativeBrowser,
  getLocalFileBrowserBridge,
  getNativeBrowserAutomationBridge,
  getNativeBrowserBridge,
} from './lib/nativeBrowser';
import { createLocalHtmlOpener, createLocalPagesCapability, localHtmlLinkHandler, openFileOrLocalHtml, reportLocalHtmlOpenFailure } from './lib/localHtmlFiles';
import { observeDesktopFailureToasts } from './lib/desktopFailureToasts';
import { getBrowserReceiptBridge } from './lib/browserReceipts';
import { canUseBrowserOverlayDialog } from './lib/browserOverlayDialog';
import { matchShortcutAction, shortcutTooltip, terminalPassesChordToPty } from './composables/useShortcuts';
import { OpenShortcutSettingsKey } from './lib/shortcutSettings';
import type { ShortcutActionId } from '../shared/action-ids';
import { useAppDialogs, useWorkspaceFolderPicker } from '@moonshot-ai/app-client/composables';
import { useWorkspaceTrust } from '@moonshot-ai/app-client/composables';
import { shortcutActionById } from './lib/keymap';
import {
  canOpenInNative,
  listNativeOpenInApps,
  openInAppIcon,
  openInNativeApp,
} from './lib/nativeOpenIn';
import { OpenInServiceKey, type OpenInService } from '@moonshot-ai/app-client/contracts';
import { resolveOpenInTarget, useDefaultOpenInTarget } from '@moonshot-ai/app-components';
import { track } from './lib/track';
import { watchStartupMilestones } from './lib/startupMilestones';
import { openUpgrade, resolveUpgradeRegion, setUpgradeRegionProbe } from '@moonshot-ai/app-core/lib';
import { setSessionIntent } from './lib/session-intent';
import type { SessionCreatedSource } from '../shared/track-events';
import { isAppActionId, type AppActionId } from '../shared/action-ids';
import { createBrowserId } from '../shared/browser';
import type { BrowserUiCommandRequest, BrowserUiState } from '../shared/browser-automation';
import type { BrowserSettingsSection } from '../shared/browser-data';

clearEmbeddedServerCredential(window.location.search);
initServerAuth();
{
  const startupCredential = getCredential();
  if (startupCredential !== undefined) {
    const bridge = (
      window as { kimiDesktop?: { updateServerCredential?: (token: string) => Promise<void> } }
    ).kimiDesktop;
    void bridge?.updateServerCredential?.(startupCredential);
  }
}
let offAuthRequired: (() => void) | null = null;

useMenuDragRegions();
const client = useKimiWebClient();
const desktopBridge = hasDesktopBridge();
const sessionViews = sessionViewsStore();
provide(ComposerNativeMenuHostKey, { register: registerBrowserOverlayMenu });
const browserAnnotationHost = createBrowserAnnotationHost({
  context: () => JSON.stringify([client.activeSessionId.value, client.activeWorkspaceId.value]),
  t: (key, values) => t(key, values ?? {}),
  notify: (message) => client.notify({ severity: 'warning', title: message }),
  revealBrowser: (browserId) => {
    const target = panel.panelTabs.value.find((tab) => tab.type === 'browser' && (tab.payload as BrowserTabPayload).browserId === browserId);
    if (target === undefined) return false;
    panel.activateTab(target.id);
    return true;
  },
});
if (browserAnnotationHost !== null) provide(ComposerBrowserReferenceHostKey, browserAnnotationHost);
const browserReceiptBridge = getBrowserReceiptBridge();
if (browserReceiptBridge !== null) provide(BrowserReceiptReaderKey, (sessionId, receiptId) => browserReceiptBridge.browserReadReceipt(sessionId, receiptId));
const browserFaviconBridge = getNativeBrowserBridge();
const browserFavicons = browserFaviconBridge === null ? null : createBrowserFaviconSource(() => browserFaviconBridge.browserGetData());
if (browserFavicons !== null) provide(BrowserFaviconSourceKey, browserFavicons);
const releaseBrowserAnnotationRequest = (window as { kimiDesktop?: { onBrowserAnnotationRequested?: (cb: (request: BrowserAnnotationContextRequest) => void) => () => void } }).kimiDesktop?.onBrowserAnnotationRequested?.((request) => {
  if (!panel.panelTabs.value.some((tab) => tab.type === 'browser' && (tab.payload as BrowserTabPayload).browserId === request.browserId)) return;
  void browserAnnotationHost?.beginPick(request.browserId, request.targetId);
});
const releaseBrowserOpenLinkRequest = (window as { kimiDesktop?: { onBrowserOpenLinkRequested?: (cb: (request: { browserId: string; url: string; background?: boolean }) => void) => () => void } }).kimiDesktop?.onBrowserOpenLinkRequested?.((request) => {
  const bridge = getNativeBrowserBridge();
  if (bridge) void openBrowserLinkTab(panel, request.browserId, request.url, (id, url) => bridge.browserNavigate(id, url), request.background === true).catch(error => console.error('Could not open browser link', error));
});
onUnmounted(() => releaseBrowserOpenLinkRequest?.());
const releaseBrowserCloseRequest = (window as { kimiDesktop?: { onBrowserCloseRequested?: (cb: (browserId: string) => void) => () => void } }).kimiDesktop?.onBrowserCloseRequested?.((browserId) => {
  const owner = panel.browserTabOwner(browserId);
  if (owner) panel.closeSessionBrowserTab(owner.sessionId, owner.tabId);
});
onUnmounted(() => releaseBrowserCloseRequest?.());
watch(() => [client.activeSessionId.value, client.activeWorkspaceId.value], () => browserAnnotationHost?.cancelAll());
onUnmounted(() => { releaseBrowserAnnotationRequest?.(); browserAnnotationHost?.dispose(); });
provide(ResolveImageKey, client.resolveImageUrl);
provide(RevealInFolderKey, (path: string) => {
  if (canOpenInNative() && (isMacosDesktop || isWindowsDesktop)) {
    return openInNativeApp(isMacosDesktop ? 'finder' : 'explorer', path);
  }
  const cwd = client.status.value.cwd;
  const rel = cwd ? pathRelativeTo(path, cwd) : null;
  if (rel !== null) return client.revealWorkspaceFile(rel);
  const absolute = path.startsWith('/') || path.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(path);
  return absolute ? Promise.resolve(false) : client.revealWorkspaceFile(path);
});
provide(OpenWithDefaultAppKey, canOpenInNative() ? (path: string) => openInNativeApp('system', path) : undefined);
provide(InsertPathMentionKey, (path: string, kind: 'file' | 'folder') => {
  conversationPaneRef.value?.insertComposerPathMention(path, kind);
});
provide(
  ResolveSwarmMembersKey,
  (toolCallId: string): SwarmMember[] => client.swarmMembersByToolCallId.value.get(toolCallId) ?? [],
);
provide(ModelDisplayKey, (alias: string | undefined): string | undefined =>
  modelDisplayName(alias, client.models.value),
);
const { t, locale } = useI18n();
onUnmounted(observeDesktopFailureToasts(client.notify, t));
provide(FetchTurnFileContentKey, turnFileContentFetcher(() => client.activeSessionId.value || undefined));
provide(SubagentEffortKey, (effort: string | undefined): string | undefined =>
  subagentEffortSuffix(effort),
);
const { confirm, isConfirmOpen, settle: settleConfirm, busy: confirmBusy } = useConfirmDialog();

const workspaces = workspacesStore();
const { visibleWorkspace, activeWorkspaceId } = storeToRefs(workspaces);
const { mobileWorkspaceGroups, pinnedSessions, attentionBySession, attentionByWorkspace } =
  storeToRefs(sessionViews);
const { models, activeModels, starredModelIds, defaultModel } = storeToRefs(modelsStore());
const { pending: modelSwitchConfirmPending } = storeToRefs(modelSwitchConfirmStore());
const { notifyEnabled, notifySound, notifyPermission } = storeToRefs(notificationsStore());
const { setNotifyEnabled, setNotifySound } = notificationsStore();
const { signedIn, managedProviderStatus, managedUserInfo } = storeToRefs(authStore());
const { pinnedSessionIds } = storeToRefs(sessionsStore());
const {
  activeSessionId,
  status,
  mainView,
  initialized,
  connectIssue,
  bootStage,
  bootRetries,
  planMode,
  planArmed,
  swarmMode,
  goalMode,
  thinking,
  working,
  queued,
  pendingQuestionActions,
  pendingApprovalActions,
  loadMoreMessagesError,
  sessionCost,
  config,
  serverVersion,
  colorScheme,
  fontScale,
  flatSessions,
  flatSessionsHasMore,
  flatSessionsLoadingMore,
  setThinking,
  togglePlanMode,
  toggleGoalMode,
  toggleSwarmMode,
  setPermission,
  toggleStarModel,
  renameSession,
  regenerateSessionTitle,
  archiveSessionWithToast,
  deleteSessionWithToast,
  loadMoreSessions,
  ensureFlatSessions,
  loadMoreFlatSessions,
  browseFs,
  getFsHome,
  mkdirFs,
  getUsage,
} = client;
watchStartupMilestones(initialized, bootStage);

const isMobile = useIsMobile();

const isFullscreen = useFullscreen();

const { vibrancy } = useVibrancy();

const terminalStore = useNativeTerminal();
const terminalOpen = terminalStore.open;
const terminalEverOpened = ref(terminalOpen.value);
watch(terminalOpen, (isOpen) => {
  if (isOpen) terminalEverOpened.value = true;
});
const terminalCwd = computed(
  () => client.visibleWorkspace.value?.root ?? client.status.value.cwd ?? null,
);
function terminalBucketKey(sessionId: string, workspaceId: string | null): string {
  return sessionId === '' ? nativeTerminalDraftKey(workspaceId) : sessionId;
}

const terminalSwitching = ref(false);
watch(
  () => [client.activeSessionId.value, client.activeWorkspaceId.value] as const,
  ([sessionId, workspaceId]) => {
    const promotion = client.getDraftPromotion();
    if (sessionId !== '' && promotion?.sessionId === sessionId) {
      terminalStore.migrateDraftTo(nativeTerminalDraftKey(promotion.workspaceId), sessionId);
    }
    terminalStore.switchSession(terminalBucketKey(sessionId, workspaceId));
    terminalSwitching.value = true;
    void nextTick(() => {
      terminalSwitching.value = false;
    });
  },
  { immediate: true },
);

useTrayAttention(client);

useJumpList(client, (payload) => {
  runWhenInitialized(client.initialized, () => {
    if (payload.action === 'new-chat') {
      setSessionIntent('jump_list');
      handleCreateSession();
    } else {
      void openWorkspaceByRoot(payload.root, payload.newChat);
    }
  });
});

function togglePinFromHeader(id: string): void {
  if (!pinnedSessionIds.value.includes(id)) {
    sidebarRef.value?.revealPinnedSection();
  }
  client.togglePinSession(id);
}

  const activeDisplayStatus = computed<SessionDisplayStatus>(() => {
  const id = client.activeSessionId.value;
  const session = client.sessions.value.find((s) => s.id === id);
  return sessionDisplayStatus({
    busy: session?.busy ?? false,
    unread: client.unreadBySession.value[id ?? ''] ?? false,
    questionCount: client.questions.value.length,
    approvalCount: client.pendingApprovals.value.length,
    pendingInteraction: session?.pendingInteraction,
    lastTurnReason: sessionViews.activeLastTurnReason ?? undefined,
  });
});

usePageTitle({ title: desktopBridge ? 'Kimi Code' : client.documentBaseTitle });

const statusPanelModel = computed(() =>
  client.models.value.find((m) => m.id === client.status.value.modelId),
);
const statusPanelThinking = computed<ThinkingLevel>(() =>
  effectiveThinkingLevel(statusPanelModel.value, client.thinking.value),
);

let appHeightRaf = 0;
const writeAppViewportVars = createAppViewportVarsWriter(document.documentElement.style);
function setAppHeight(): void {
  const vv = window.visualViewport;
  writeAppViewportVars({ height: vv?.height ?? window.innerHeight, top: vv?.offsetTop ?? 0 });
}
function syncAppHeight(): void {
  if (appHeightRaf) return;
  appHeightRaf = requestAnimationFrame(() => {
    appHeightRaf = 0;
    setAppHeight();
  });
}

setUpgradeRegionProbe(() => client.getOAuthRegion());
function refreshUpgradeRegion(): void {
  void resolveUpgradeRegion(() => client.getOAuthRegion());
}

onMounted(() => {
  offAuthRequired = onAuthRequired(() => {
    authRequired.value = true;
    client.clearDangerousBypassAuth();
  });
  void client.load();
  refreshUpgradeRegion();
  setAppHeight();
  window.visualViewport?.addEventListener('resize', syncAppHeight);
  window.visualViewport?.addEventListener('scroll', syncAppHeight);
  window.addEventListener('resize', syncAppHeight);
  window.addEventListener('resize', onTerminalWindowResize);
  installImeCompositionLatch();
  window.addEventListener('keydown', onShortcutKeydown);
  offMenuAction =
    (window as { kimiDesktop?: { onMenuAction?: (cb: (id: string) => void) => () => void } })
      .kimiDesktop?.onMenuAction?.((menuId) => {
      if (menuId === 'close-panel-tab') {
        if (anyOverlayOpen.value) return;
        if (panel.panelVisible.value && panel.activeTabId.value) {
          if (panelTabsRef.value?.requestClose) void panelTabsRef.value.requestClose('close', panel.activeTabId.value);
          else panel.closeTab(panel.activeTabId.value);
        }
        else window.close();
        return;
      }
      if (menuId === 'browser-reload' || menuId === 'browser-new-tab' || menuId === 'browser-focus-address') {
        if (anyOverlayOpen.value) return;
        const action = menuId === 'browser-reload' ? 'reload' : menuId === 'browser-new-tab' ? 'new-tab' : 'focus-address';
        void (async () => {
          const handled = await panelTabsRef.value?.browserShortcut(action);
          if (!handled && action === 'reload') window.location.reload();
        })().catch((error: unknown) => client.notify({ severity: 'warning', title: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (menuId === 'select-all') {
        track('action_invoked', { action: 'select-all', source: 'menu' });
        selectAllFromMenu();
        return;
      }
      if (menuId === 'undo' || menuId === 'redo') {
        undoRedoFromMenu(menuId);
        return;
      }
      if (menuId === 'retry-connection') {
        track('action_invoked', { action: 'retry-connection', source: 'menu' });
        return;
      }
      const actionId = MENU_ACTION_TO_SHORTCUT[menuId];
      if (actionId === undefined) return;
      if (
        anyOverlayOpen.value &&
        !(actionId === 'openSettings' && (showSettings.value || showMobileSettings.value)) &&
        actionId !== 'closeSessionView'
      ) {
        return;
      }
      runShortcutAction(actionId, 'menu');
    }) ?? null;
  const browserAutomationBridge = getNativeBrowserAutomationBridge();
  offBrowserAutomationUiRequest =
    browserAutomationBridge?.onBrowserAutomationUiRequest((request) => {
      if ('cancel' in request) {
        browserUiRequests.cancel(request.requestId);
        return;
      }
      browserUiRequests.accept(request.requestId);
      const receivedAt = Date.now();
      void enqueueBrowserUiCommand(request.sessionId ?? '', () => handleBrowserAutomationUiRequest(request, receivedAt));
    }) ?? null;
  offScreenshotHotkey =
    (window as { kimiDesktop?: { onScreenshotHotkey?: (cb: () => void) => () => void } })
      .kimiDesktop?.onScreenshotHotkey?.(() => {
      armHotkeyScreenshot();
    }) ?? null;
  offScreenshotHotkeyResult =
    (window as {
      kimiDesktop?: {
        onScreenshotHotkeyResult?: (cb: (result: ScreenshotCaptureBridgeResult) => void) => () => void;
      };
    })
      .kimiDesktop?.onScreenshotHotkeyResult?.((result) => {
      consumeHotkeyScreenshotResult(result);
    }) ?? null;
});

onUnmounted(() => {
  window.removeEventListener('keydown', onShortcutKeydown);
  if (offMenuAction !== null) {
    offMenuAction();
    offMenuAction = null;
  }
  if (offBrowserAutomationUiRequest !== null) {
    offBrowserAutomationUiRequest();
    offBrowserAutomationUiRequest = null;
  }
  if (offScreenshotHotkey !== null) {
    offScreenshotHotkey();
    offScreenshotHotkey = null;
  }
  if (offScreenshotHotkeyResult !== null) {
    offScreenshotHotkeyResult();
    offScreenshotHotkeyResult = null;
  }
  window.visualViewport?.removeEventListener('resize', syncAppHeight);
  window.visualViewport?.removeEventListener('scroll', syncAppHeight);
  window.removeEventListener('resize', syncAppHeight);
  window.removeEventListener('resize', onTerminalWindowResize);
  if (appHeightRaf) {
    cancelAnimationFrame(appHeightRaf);
    appHeightRaf = 0;
  }
  document.documentElement.style.removeProperty('--app-height');
  document.documentElement.style.removeProperty('--app-top');
  if (offAuthRequired !== null) {
    offAuthRequired();
    offAuthRequired = null;
  }
});

let offMenuAction: (() => void) | null = null;
let offBrowserAutomationUiRequest: (() => void) | null = null;
let offScreenshotHotkey: (() => void) | null = null;
let offScreenshotHotkeyResult: (() => void) | null = null;

const MENU_ACTION_TO_SHORTCUT: Record<string, AppActionId> = {
  'open-settings': 'openSettings',
  'new-chat': 'newSession',
  'close-session-view': 'closeSessionView',
  'open-folder': 'openFolder',
  'toggle-terminal': 'toggleTerminal',
  'new-terminal-tab': 'newTerminalTab',
};

const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null);

const OPEN_IN_FILE_EXCLUDED_IDS: ReadonlySet<string> = new Set([
  'terminal',
  'iterm',
  'ghostty',
  'warp',
  'kitty',
  'windows-terminal',
  'git-bash',
]);

const openInService: OpenInService = {
  catalog: async (kind, filePath) => {
    if (!canOpenInNative()) return [];
    const apps = await listNativeOpenInApps(kind === 'file' ? filePath : undefined);
    return kind === 'file' ? apps.filter((app) => !OPEN_IN_FILE_EXCLUDED_IDS.has(app.id)) : apps;
  },
  open: (appId, target) => openInNativeApp(appId, target.path),
  icon: (appId) => openInAppIcon(appId),
};
provide(OpenInServiceKey, openInService);

async function openWorkspaceInDefaultApp(): Promise<void> {
  const root = client.visibleWorkspace.value?.root ?? client.status.value.cwd;
  if (!root) return;
  const apps = await openInService.catalog();
  const target = resolveOpenInTarget(
    apps.map((app) => app.id),
    useDefaultOpenInTarget().value,
  );
  if (target === null) return;
  await openInService.open(target, { path: root });
}

const SESSION_INTENT_BY_ACTION_SOURCE: Record<'shortcut' | 'menu' | 'button', SessionCreatedSource> = {
  shortcut: 'shortcut',
  menu: 'menu',
  button: 'sidebar',
};

function runShortcutAction(id: AppActionId, source: 'shortcut' | 'menu' | 'button'): void {
  track('action_invoked', { action: id, source });
  switch (id) {
    case 'openSettings':
      if (isMobile.value) {
        showMobileSettings.value = !showMobileSettings.value;
      } else {
        showSettings.value = !showSettings.value;
      }
      break;
    case 'toggleSidebar':
      toggleSidebarCollapse();
      break;
    case 'toggleRightPanel': {
      const panelRoot = panelTabsRef.value?.rootEl ?? null;
      const focusInside = panelRoot !== null && panelRoot.contains(document.activeElement);
      toggleRightPanel();
      if (focusInside) void nextTick(focusClosedPanelToggle);
      break;
    }
    case 'searchSessions':
      sidebarRef.value?.toggleSearch();
      break;
    case 'newSession':
      setSessionIntent(SESSION_INTENT_BY_ACTION_SOURCE[source]);
      handleCreateSession();
      break;
    case 'closeSessionView':
      if (!anyOverlayOpen.value && panel.panelVisible.value && panel.activeTabId.value) {
        if (panelTabsRef.value?.requestClose) void panelTabsRef.value.requestClose('close', panel.activeTabId.value);
        else panel.closeTab(panel.activeTabId.value);
        break;
      }
      if (
        !anyOverlayOpen.value &&
        (mainView.value === 'sessionAdmin' || client.activeSessionId.value)
      ) {
        handleCreateSession();
      } else {
        hideWindowFromShortcut();
      }
      break;
    case 'archiveSession': {
      const sid = client.activeSessionId.value;
      if (sid && !client.activeSessionArchived.value) void client.archiveSessionWithToast(sid);
      break;
    }
    case 'toggleSideChat':
      toggleBtwPanel();
      break;
    case 'openFolder':
      requestWorkspaceDialog();
      break;
    case 'openInDefaultApp':
      void openWorkspaceInDefaultApp();
      break;
    case 'newTerminalTab':
      void openTermTab();
      break;
    case 'toggleTerminal':
      if (!isMobile.value && terminalStore.available) {
        terminalStore.toggle(terminalCwd.value ?? undefined);
      }
      break;
    case 'nextPanelTab':
    case 'previousPanelTab': {
      const direction = id === 'nextPanelTab' ? 1 : -1;
      if (document.activeElement instanceof HTMLElement && terminalStore.open.value && document.activeElement.closest('.terminal-panel') && terminalStore.tabs.value.length > 1) {
        const tabs = terminalStore.tabs.value;
        const index = tabs.findIndex(tab => tab.id === terminalStore.activeTabId.value);
        terminalStore.activateTab(tabs[(index + direction + tabs.length) % tabs.length]!.id);
        void nextTick(() => document.querySelector<HTMLElement>('.tp-tab.active .tp-tab-main')?.focus());
      } else if (panel.cycleTab(direction)) {
        focusAfterTabClose();
      }
      break;
    }
    case 'openDiffTab':
      if (client.activeSessionId.value) panel.openDiffDetail();
      break;
    case 'toggleFilesPanel':
      if (panel.panelVisible.value && panel.activeTab.value?.type === 'files') panel.hidePanel();
      else panel.openFilesPanel();
      break;
    case 'sidebarTabOpen':
    case 'sidebarTabDone':
    case 'sidebarTabWorkspaces':
      sidebarRef.value?.setStatusTab(
        id === 'sidebarTabOpen' ? 'open' : id === 'sidebarTabDone' ? 'done' : 'workspaces',
      );
      break;
    case 'selectPrevSibling':
      sidebarRef.value?.selectSibling(-1);
      break;
    case 'selectNextSibling':
      sidebarRef.value?.selectSibling(1);
      break;
    case 'captureScreenshot':
      void handleScreenshot();
      break;
  }
}

function hideWindowFromShortcut(): void {
  const bridge = (window as { kimiDesktop?: { hideWindow?: () => void } }).kimiDesktop;
  if (typeof bridge?.hideWindow === 'function') {
    bridge.hideWindow();
  } else {
    window.close();
  }
}

function selectAllFromMenu(): void {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    active.select();
    return;
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    selectContentsOf(active);
    return;
  }
  if (anyOverlayOpen.value) {
    selectContentsOf(document.body);
    return;
  }
  conversationPaneRef.value?.selectAllRegion(active);
}

function undoRedoFromMenu(command: 'undo' | 'redo'): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (runComposerMenuEdit(active, command)) return;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable) {
    document.execCommand(command);
  }
}

function onShortcutKeydown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (e.isComposing || e.keyCode === 229) return;
  if (e.repeat) return;
  const id = matchShortcutAction(e, 'global');
  if (id === null || !isAppActionId(id)) return;
  if (
    e.target instanceof HTMLElement &&
    e.target.closest('.terminal-host') !== null &&
    terminalPassesChordToPty(e, id)
  ) {
    return;
  }
  const action = shortcutActionById(id);
  if (action?.requiresSession === true && !client.activeSessionId.value) return;
  if (anyOverlayOpen.value) {
    const closesOpenDialog =
      (id === 'openSettings' && (showSettings.value || showMobileSettings.value)) ||
      (id === 'searchSessions' && sidebarRef.value?.isSearchOpen() === true);
    if (!closesOpenDialog && id !== 'closeSessionView') return;
  }
  if (id === 'toggleTerminal' && !terminalStore.available) return;
  if (id === 'captureScreenshot') {
    const bridge = (window as { kimiDesktop?: { captureScreenshot?: unknown } }).kimiDesktop;
    if (typeof bridge?.captureScreenshot !== 'function') return;
  }
  e.preventDefault();
  runShortcutAction(id, 'shortcut');
}

const filePreview = useFilePreview({
  client,
  t: (key, params) => (params === undefined ? t(key) : t(key, params)),
});

const {
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  sidebarMax,
  sessionColWidth,
  sidebarCollapsed,
  sidebarDragging,
  sideWidth,
  sidebarOccupiedWidth,
  toggleSidebarCollapse,
} = useSidebarLayout({ previewOpen: () => panel.panelVisible.value });

const browserPersistenceBridge = getNativeBrowserBridge();
const panel = usePanelTabs({
  client,
  sideWidth: sidebarOccupiedWidth,
  browserPersistence: browserPersistenceBridge === null ? undefined : {
    load: () => browserPersistenceBridge.browserGetSessions(),
    save: (sessions) => browserPersistenceBridge.browserSaveSessions(sessions),
    onError: (error) => console.error('Failed to persist browser tabs', error),
  },
  onBrowserSuspended: browserPersistenceBridge === null ? undefined : (tab) => {
    browserPersistenceBridge.browserSuspend((tab.payload as BrowserTabPayload).browserId);
  },
  t: (key, params) => (params === undefined ? t(key) : t(key, params)),
  locale,
  onTabRemoved: (tab) => {
    if (tab.payload === undefined) return;
    if (tab.type === 'term') {
      const ptyId = (tab.payload as TermTabPayload).ptyId;
      if (ptyId !== undefined) terminalStore.closePanelTab(ptyId);
    } else if (tab.type === 'browser') {
      getNativeBrowserBridge()?.browserClose((tab.payload as BrowserTabPayload).browserId);
    }
  },
});

let stopBrowserPermissions: (() => void) | undefined;
onMounted(() => { stopBrowserPermissions = observeBrowserPermissions(); });
onUnmounted(() => { stopBrowserPermissions?.(); sessionViews.localApprovalCounts = {}; });
let stopBrowserPageDialogs: (() => void) | undefined;
onMounted(() => { stopBrowserPageDialogs = observeBrowserPageDialogs(); });
onUnmounted(() => { stopBrowserPageDialogs?.(); });
watchEffect(() => {
  const counts: Record<string, number> = {};
  for (const browserId of browserApprovalBrowserIds.value) {
    const owner = panel.browserTabOwner(browserId);
    if (owner) counts[owner.sessionId] = (counts[owner.sessionId] ?? 0) + 1;
  }
  sessionViews.localApprovalCounts = counts;
});
watch([activeSessionId, mainView], async ([sessionId, view]) => {
  if (!sessionId || view !== 'chat') return;
  await nextTick();
  const owner = browserApprovalBrowserIds.value.map(browserId => panel.browserTabOwner(browserId)).find(owner => owner?.sessionId === sessionId);
  if (owner && (panel.activeTab.value?.id !== owner.tabId || !panel.panelVisible.value)) showBrowserTab(panel, sessionId, sessionId, owner.tabId);
});

function browserAutomationUiState(sessionId: string): BrowserUiState {
  panel.syncBrowserControls(client.getSessionExecutionState);
  const tabs = panel.sessionBrowserTabs(sessionId);
  const controlled = tabs.find(tab => (tab.payload as BrowserTabPayload).controlled?.status === 'running');
  const controller = controlled === undefined ? undefined : (controlled.payload as BrowserTabPayload).controlled?.controller;
  const viewing = sessionId === client.activeSessionId.value;
  const active = panel.activeTab.value;
  return {
    panelVisible: viewing && panel.panelVisible.value,
    activeTabId: viewing && active?.type === 'browser' ? active.id : null,
    ...(controlled === undefined
      ? { controlledTabId: null, controlledLeaseId: null }
      : { controlledTabId: controlled.id, controlledLeaseId: (controlled.payload as BrowserTabPayload).controlled!.leaseId }),
    ...(controller === undefined ? {} : { controlledController: controller }),
    turnId: client.getSessionExecutionState(sessionId).turnId,
    tabs: tabs.map(tab => ({ tabId: tab.id, browserId: (tab.payload as BrowserTabPayload).browserId })),
    workspaceRoot: client.sessions.value.find(session => session.id === sessionId)?.cwd ?? null,
    permissionMode: permissionsStore().forSession(sessionId) ?? 'manual',
  };
}

const enqueueBrowserUiCommand = createBrowserUiCommandQueue();
const browserUiRequests = createBrowserUiRequestTracker();
const sessionResolving = (sessionId: string): boolean => client.getSessionExecutionState(sessionId).resolving === true;
const browserCommandGate = createBrowserCommandGate({
  watchResolving: (sessionId, ended) => watch(() => sessionResolving(sessionId), resolving => { if (!resolving) ended(); }, { flush: 'sync' }),
});

async function handleBrowserAutomationUiRequest(request: BrowserUiCommandRequest, receivedAt: number): Promise<void> {
  const bridge = getNativeBrowserAutomationBridge();
  if (bridge === null || !browserUiRequests.isLive(request.requestId)) return;
  let releaseExecution: (() => void) | undefined;
  try {
    await panel.browserPersistenceReady;
    const { command, sessionId, controller } = request;
    if (sessionId === undefined) throw new Error('Browser request has no session identity.');
    releaseExecution = await browserCommandGate.enter(command.action, sessionId, {
      receivedAt,
      controlled: panel.isBrowserSessionControlled(sessionId),
      resolving: () => sessionResolving(sessionId),
      prepare: timeoutMs => prepareBrowserExecution(
        () => client.retainSessionExecution(sessionId),
        timeoutMs,
        remainingMs => client.awaitSessionExecutionState(sessionId, remainingMs),
      ),
    }, controller !== undefined);
    if (!browserUiRequests.isLive(request.requestId)) return;
    panel.syncBrowserControls(client.getSessionExecutionState);
    const execution = client.getSessionExecutionState(sessionId);
    if (controller === undefined && browserCommandTakesControl(command.action)) {
      if (execution.status !== 'running' || execution.turnId === null) throw new Error('Browser control requires a running turn.');
    }
    const turnId = controller === undefined ? execution.turnId! : String(controller.run.turnId);
    if (command.action === 'activate_panel' || command.action === 'switch_tab') {
      showBrowserTab(panel, sessionId, client.activeSessionId.value, command.action === 'switch_tab' ? command.tabId : undefined);
    } else if (command.action === 'create_tab') {
      const tab = panel.addSessionBrowserTab(sessionId, { browserId: createBrowserId() });
      panel.controlBrowserTab(sessionId, tab.id, turnId, controller);
    } else if (command.action !== 'get_state') {
      const target = panel.sessionBrowserTabs(sessionId).find(tab => tab.id === command.tabId);
      if (target === undefined) throw new Error(`Browser tab "${command.tabId}" does not exist.`);
      if (command.action === 'activate_tab') {
        panel.controlBrowserTab(sessionId, target.id, turnId, controller);
        await getNativeBrowserBridge()?.getBrowserState((target.payload as BrowserTabPayload).browserId);
      }
      else if (command.action === 'release_tab' || command.action === 'close_tab') {
        const completed = command.action === 'release_tab'
          ? panel.releaseBrowserTab(sessionId, target.id, command.expectedLeaseId)
          : panel.closeSessionBrowserTab(sessionId, target.id, command.expectedLeaseId);
        if (!completed) throw new Error('Browser control changed; request a new operation under the current control.');
      }
    }
    await nextTick();
    bridge.browserAutomationUiRespond({ requestId: request.requestId, ok: true, state: browserAutomationUiState(sessionId) });
  } catch (error) {
    bridge.browserAutomationUiRespond({ requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    browserUiRequests.cancel(request.requestId);
    releaseExecution?.();
  }
}

useTerminalActivity(terminalStore, {
  intervalMs: isWindowsDesktop ? 10_000 : 1500,
  visibleIds: () => [
    ...(terminalStore.open.value ? terminalStore.tabs.value.map(tab => tab.id) : []),
    ...(panel.panelVisible.value ? panel.panelTabs.value.flatMap(tab => {
      if (tab.type !== 'term') return [];
      const id = (tab.payload as TermTabPayload | undefined)?.ptyId;
      return id === undefined ? [] : [id];
    }) : []),
  ],
});

const btwToggleInFlight = new Map<string, Promise<{ sessionId: string | null; agentId: string | null }>>();

watchEffect(() => panel.syncBrowserControls(client.getSessionExecutionState));
if (getNativeBrowserBridge() !== null) provide(BrowserLiveViewKey, createBrowserLiveView(panel, () => client.activeSessionId.value));
if (browserFavicons !== null) {
  watch(
    () => browserFaviconSignature(panel.panelTabs.value.flatMap((tab) => tab.type === 'browser'
      ? [{ id: tab.id, favicon: (tab.payload as BrowserTabPayload).favicon }]
      : [])),
    () => browserFavicons.reload(),
  );
}
const browserOutOfView = computed(() => browserControlOutOfView(panel, client.activeSessionId.value));
const stopBrowserControlPresentation = watchBrowserControlPresentation(() => {
  const sessions = new Set(panel.controlledBrowserSessions());
  if (client.activeSessionId.value) sessions.add(client.activeSessionId.value);
  return [...sessions].flatMap(sessionId => panel.sessionBrowserTabs(sessionId).map(tab => {
    const payload = tab.payload as BrowserTabPayload;
    const execution = client.getSessionExecutionState(sessionId);
    const controller = payload.controlled?.controller;
    return {
      browserId: payload.browserId,
      sessionId,
      turnId: controller === undefined ? execution.turnId : String(controller.run.turnId),
      status: payload.controlled?.status ?? 'idle' as const,
      ...(controller === undefined ? {} : { controller }),
    };
  }));
}, t, state => {
  for (const sessionId of state.sessionIds) {
    if (panel.controlledBrowserSessions().includes(sessionId)) panel.releaseBrowserMainControl(sessionId);
  }
  for (const { sessionId, run } of state.runs) panel.releaseBrowserRun(sessionId, run);
});
onUnmounted(stopBrowserControlPresentation);
const browserExecutionLeases = new Map<string, () => void>();
watchEffect(() => {
  const sessions = new Set(panel.controlledBrowserSessions());
  for (const [sessionId, release] of browserExecutionLeases) {
    if (sessions.has(sessionId)) continue;
    release();
    browserExecutionLeases.delete(sessionId);
  }
  for (const sessionId of sessions) {
    if (!browserExecutionLeases.has(sessionId)) browserExecutionLeases.set(sessionId, client.retainSessionExecution(sessionId));
  }
});
onUnmounted(() => {
  for (const release of browserExecutionLeases.values()) release();
});

function toggleBtwPanel(): void {
  if (panel.activeTab.value?.type === 'btw' && panel.panelVisible.value) {
    const panelRoot = panelTabsRef.value?.rootEl ?? null;
    const focusInside = panelRoot !== null && panelRoot.contains(document.activeElement);
    panel.hidePanel();
    if (focusInside) void nextTick(focusClosedPanelToggle);
    return;
  }
  const latest = panel.panelTabs.value.findLast((tab) => tab.type === 'btw');
  const sideChatFocus = armSideChatFocus();
  if (latest) {
    panel.activateTab(latest.id);
    sideChatFocus.focusWhenReady();
    return;
  }
  if (!client.activeSessionId.value) {
    client.notify({ severity: 'warning', title: t('sideChat.requiresSession') });
    return;
  }
  const contextKey =
    client.activeSessionId.value ||
    `${DRAFT_CONTEXT_KEY_PREFIX}${client.activeWorkspaceId.value ?? 'none'}`;
  const promotion = client.getDraftPromotion();
  const aliasKey =
    promotion !== null && promotion.sessionId === contextKey
      ? `${DRAFT_CONTEXT_KEY_PREFIX}${promotion.workspaceId}`
      : null;
  const pending =
    btwToggleInFlight.get(contextKey) ??
    (aliasKey !== null ? btwToggleInFlight.get(aliasKey) : undefined);
  if (pending !== undefined) {
    void pending.then((result) => {
      const belongsToCurrent =
        result.agentId !== null &&
        (result.sessionId === null || result.sessionId === client.activeSessionId.value);
      if (!belongsToCurrent) return;
      if (!sideChatFocus.acted()) {
        const landed = panel.panelTabs.value.find(
          (tab) =>
            tab.type === 'btw' &&
            (tab.payload as BtwTabPayload | undefined)?.agentId === result.agentId,
        );
        if (landed) panel.activateTab(landed.id);
      }
      sideChatFocus.focusWhenReady();
    });
    return;
  }
  const open = panel.openSideChatTab();
  btwToggleInFlight.set(contextKey, open);
  void open
    .then((result) => {
      if (
        result.agentId !== null &&
        (result.sessionId === null || result.sessionId === client.activeSessionId.value)
      ) {
        sideChatFocus.focusWhenReady();
      }
    })
    .finally(() => {
      if (btwToggleInFlight.get(contextKey) === open) btwToggleInFlight.delete(contextKey);
    });
}

function openBtwFromPanel(): Promise<{ sessionId: string | null; agentId: string | null }> {
  if (!client.activeSessionId.value) {
    client.notify({ severity: 'warning', title: t('sideChat.requiresSession') });
    return Promise.resolve({ sessionId: null, agentId: null });
  }
  return panel.openSideChatTab();
}

const panelHasTermTabs = computed(() =>
  panel.panelTabs.value.some((tab) => tab.type === 'term'),
);

function focusHandoffAfterReap(reapedActive: boolean, focusWasInside: boolean): void {
  if (!focusWasInside) return;
  if (reapedActive) {
    focusAfterTabClose();
    return;
  }
  void nextTick(() => {
    if (document.activeElement === document.body) focusAfterTabClose();
  });
}
function reapFocusSnapshot(reapedIds: readonly string[]): { reapedActive: boolean; focusWasInside: boolean } {
  const panelRoot = panelTabsRef.value?.rootEl ?? null;
  return {
    reapedActive: reapedIds.some((id) => id === panel.activeTabId.value),
    focusWasInside: panelRoot !== null && panelRoot.contains(document.activeElement),
  };
}

const deadBtwTabIds = computed(() =>
  panel.panelTabs.value
    .filter((tab) => tab.type === 'btw' && tab.payload !== undefined)
    .filter((tab) => {
      const payload = tab.payload as BtwTabPayload;
      return !client.sideChatTargetsOfSession(payload.parentId).some(
        (target) => target.agentId === payload.agentId,
      );
    })
    .map((tab) => tab.id),
);
function reapPanelTabs(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const snapshot = reapFocusSnapshot(ids);
  for (const id of ids) panel.closeTab(id);
  focusHandoffAfterReap(snapshot.reapedActive, snapshot.focusWasInside);
}
watch(deadBtwTabIds, reapPanelTabs);


const canOpenTermTab = computed(() => terminalStore.available && !isMobile.value);
const canOpenBrowserTab = computed(() => canUseNativeBrowser() && !isMobile.value);
const sessionInfoAvailableTabs = computed(() => panelLauncherItems({
  diff: Boolean(client.activeSessionId.value),
  files: Boolean(client.activeWorkspaceId.value),
  browser: canOpenBrowserTab.value,
  term: canOpenTermTab.value,
  btw: Boolean(client.activeSessionId.value),
}, t));
const localPagesCapability = createLocalPagesCapability(() => getLocalFileBrowserBridge()?.browserLocalPagesAllowed() ?? Promise.resolve(false));
const localHtmlOpener = createLocalHtmlOpener({
  bridge: getLocalFileBrowserBridge(),
  enabled: () => canOpenBrowserTab.value && workspaces.isLocalWorkspace,
  context: () => ({ sessionId: client.activeSessionId.value, workspaceId: client.activeWorkspaceId.value }),
  draftPromotion: () => client.getDraftPromotion(),
  interactionVersion: () => panel.panelInteractionVersion.value,
  openTab: (browserId) => {
    closeDockWorkPanel();
    panel.openTab('browser', { browserId } satisfies BrowserTabPayload);
  },
  sessionDestroyed: (sessionId) => panel.isSessionDestroyed(sessionId),
  addToSession: (sessionId, browserId) => { panel.addSessionBrowserTab(sessionId, { browserId }); },
  discard: (browserId) => getNativeBrowserBridge()?.browserClose(browserId),
});

function openFileTarget(request: FilePreviewRequest): void {
  openFileOrLocalHtml(request, localHtmlOpener, client.status.value.cwd, (target) => panel.openFilePreview(target));
}

function openTermTab(): Promise<void> | void {
  if (!canOpenTermTab.value) return;
  const sessionAtCall = client.activeSessionId.value;
  const workspaceAtCall = client.activeWorkspaceId.value;
  const interactionAtCall = panel.panelInteractionVersion.value;
  const isSpawnContextCurrent = (): boolean => {
    const promotion = client.getDraftPromotion();
    if (
      !sessionAtCall &&
      promotion !== null &&
      promotion.sessionId === client.activeSessionId.value &&
      promotion.workspaceId === workspaceAtCall
    ) {
      return true;
    }
    return (
      client.activeSessionId.value === sessionAtCall &&
      (Boolean(sessionAtCall) ||
        Boolean(client.activeSessionId.value) ||
        client.activeWorkspaceId.value === workspaceAtCall)
    );
  };
  return terminalStore
    .newPanelTab(terminalCwd.value ?? undefined, undefined, { stillValid: isSpawnContextCurrent })
    .then(({ tab: pty, error: spawnError }) => {
      if (!isSpawnContextCurrent()) {
        if (pty !== null) terminalStore.closePanelTab(pty.id);
        return;
      }
      const stillWaiting = panel.panelInteractionVersion.value === interactionAtCall;
      const payload: TermTabPayload | null =
        pty !== null
          ? { ptyId: pty.id, title: pty.shell, cwd: pty.cwd }
          : spawnError !== null
            ? { error: spawnError }
            : null;
      if (payload !== null) {
        if (stillWaiting) panel.openTab('term', payload);
        else panel.addTabInBackground('term', payload);
      }
    });
}

const restoringTermTab = ref<string | null>(null);
watch(
  [panel.panelTabs, terminalStore.bucketsWithTabs, () => client.sessionLoading.value, restoringTermTab],
  () => {
    if (!terminalStore.available || client.sessionLoading.value || restoringTermTab.value !== null) return;
    for (const tab of panel.panelTabs.value) {
      if (tab.type !== 'term') continue;
      const payload = (tab.payload ?? {}) as TermTabPayload;
      if (payload.error || (payload.ptyId && terminalStore.panelTabOf(payload.ptyId))) continue;
      const sessionId = client.activeSessionId.value;
      const workspaceId = client.activeWorkspaceId.value;
      const stillValid = (): boolean => client.activeSessionId.value === sessionId &&
        client.activeWorkspaceId.value === workspaceId && panel.panelTabs.value.some(item => item.id === tab.id);
      restoringTermTab.value = tab.id;
      void terminalStore.newPanelTab(payload.cwd ?? terminalCwd.value ?? undefined, undefined, { stillValid })
        .then(({ tab: terminal, error }) => {
          if (!stillValid()) {
            if (terminal) terminalStore.closePanelTab(terminal.id);
            return;
          }
          panel.updateTabPayload(tab.id, terminal
            ? { ptyId: terminal.id, title: terminal.shell, cwd: terminal.cwd }
            : { ...payload, ptyId: undefined, error: error ?? t('panel.terminalRestoreFailed') });
        }).finally(() => { restoringTermTab.value = null; });
      break;
    }
  }, { immediate: true },
);

function moveTerminalToPanel(id: string, index: number): void {
  const terminal = terminalStore.moveTabToPanel(id);
  if (terminal === null) return;
  const tab = panel.openTab('term', { ptyId: terminal.id, title: terminal.shell, cwd: terminal.cwd } satisfies TermTabPayload);
  panel.moveTab(tab.id, index);
}

function closeDockWorkPanel(): void {
  conversationPaneRef.value?.closeDockPanel();
}
function toggleRightPanel(): void {
  track('session_menu_action', { action: 'togglePanel' });
  if (panel.panelVisible.value) panel.hidePanel();
  else panel.showPanel();
}

const rightPanelToggleLabel = computed(() => (panel.panelVisible.value ? t('panel.hide') : t('panel.openPanel')));
const rightPanelTooltip = computed(() => shortcutTooltip(browserOutOfView.value ? `${t('browser.controlOutOfView')} · ${rightPanelToggleLabel.value}` : rightPanelToggleLabel.value, 'toggleRightPanel'));

const sidebarToggleLabel = computed(() => (sidebarCollapsed.value ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')));
const sidebarToggleTooltip = computed(() => shortcutTooltip(sidebarToggleLabel.value, 'toggleSidebar'));
const newChatTooltip = computed(() => shortcutTooltip(t('sidebar.newChat'), 'newSession'));

provide(panelApiKey, {
  openFile: (req) => {
    closeDockWorkPanel();
    panel.openFilePreview(req);
  },
  openAgent: (id) => {
    closeDockWorkPanel();
    panel.openAgentPanel(id);
  },
  openContext: () => {
    closeDockWorkPanel();
    panel.openTab('context', {});
  },
  openTurnDiff: (payload) => {
    closeDockWorkPanel();
    panel.openTurnDiff(payload);
  },
  openCompaction: (target) => {
    closeDockWorkPanel();
    panel.openCompactionPanel(target);
  },
  openDiff: () => {
    closeDockWorkPanel();
    panel.openDiffDetail();
  },
  openBtw: () => {
    closeDockWorkPanel();
    void openBtwFromPanel();
  },
  openTerm: () => {
    closeDockWorkPanel();
    openTermTab();
  },
  isVisible: () => panel.panelVisible.value,
  isExpanded: () => panel.panelExpanded.value,
  activeTabType: () => panel.activeTab.value?.type ?? null,
  activeTabPurePreview: () => {
    const active = panel.activeTab.value;
    if (active?.type !== 'file') return false;
    const payload = active.payload as FileTabPayload;
    if (typeof payload.content === 'string') return false;
    const mime = filePreview.previewFile.value?.mime ?? '';
    return isPurePreviewFile(payload.path, mime);
  },
  pfcHost: () => panelTabsRef.value?.pfcHostEl ?? null,
  togglePanel: () => {
    if (panel.panelVisible.value) {
      panel.hidePanel();
    } else {
      panel.showPanel();
    }
  },
} satisfies PanelApi);

watch(
  () => client.mainView.value,
  (view) => {
    if (view !== 'chat') panel.leaveChatView();
  },
);

const pastedTextStats = usePastedTextStats();

onMounted(() => {
  const stop = startMentionTooltip({
    resolveSkill: (name, path) => client.skills.value.find((s) => s.name === name && (path === undefined || s.path === path)) ?? null,
    openPath: (target) => void panel.openFilePreview(target),
    openAttachment: (target) => onAttachmentOpen(target),
    openSkillLabel: () => t('mention.openSkill'),
    copyPathLabel: () => t('mention.copyPath'),
    copyQuoteLabel: () => t('selection.copyQuote'),
    viewPastedTextLabel: () => t('composer.viewPastedText'),
    openPastedText: openPastedTextDialog,
    pastedTextStats,
    copyCommentLabel: () => t('selection.copyComment'),
    quoteBlockLabel: () => t('selection.quoteLabel'),
    commentBlockLabel: () => t('selection.comment'),
    attachmentErrorLabel: (error) =>
      error === 'upload-failed'
        ? t('mention.attachmentUploadFailed')
        : error === 'upload-interrupted'
          ? t('mention.attachmentUploadInterrupted')
          : undefined,
    resolveAttachmentPreviewUrl: async (target) => {
      const api = getKimiWebApi();
      try {
        const blob = target.sessionId !== undefined ? await api.getSessionMediaBlob(target.sessionId, target.fileId) : await api.getFileBlob(target.fileId);
        return URL.createObjectURL(blob);
      } catch {
        return null;
      }
    },
    mediaFullscreenLabel: () => t('mention.viewFullscreen'),
    mediaPreviewStateLabel: (state) =>
      state === 'loading'
        ? t('mention.mediaPreviewLoading')
        : state === 'uploading'
          ? t('mention.mediaPreviewUploading')
          : t('mention.mediaPreviewUnavailable'),
    mediaUploadStateLabel: (kind) =>
      kind === 'uploading'
        ? t('mention.stateUploading')
        : kind === 'uploaded'
          ? t('mention.stateUploaded')
          : t('mention.stateUploadFailed'),
    probePath: (path, kind) => client.probeWorkspacePath(path, kind),
    skillsLoaded: () => client.skillsLoaded.value,
    probeScope: () => client.activeSessionId.value || client.activeWorkspaceId.value,
  });
  onUnmounted(stop);
});

const mediaLightbox = ref<ToolMedia | null>(null);
const mediaLightboxImg = ref<HTMLImageElement | null>(null);
const mediaLightboxImages = ref<ToolMedia[] | undefined>(undefined);
const mediaLightboxIndex = ref<number | undefined>(undefined);

function onOpenMedia(payload: OpenMediaRequest): void {
  mediaLightboxImg.value = payload.originImg ?? null;
  mediaLightbox.value = payload.media;
  mediaLightboxImages.value = payload.images;
  mediaLightboxIndex.value = payload.imageIndex;
}

provide(OpenMarkdownImageKey, ({ src, alt, originImg }) =>
  onOpenMedia({ media: { kind: 'image', url: src, name: alt }, originImg }),
);

const TERMINAL_HEIGHT_KEY = 'kimi-web.terminal-panel-height';
const TERMINAL_DEFAULT_HEIGHT = 260;
const TERMINAL_MIN = 120;
const viewportHeight = ref(window.innerHeight);
const terminalMax = computed(() => Math.max(TERMINAL_MIN, Math.round(viewportHeight.value * 0.6)));
const terminalHeight = ref(TERMINAL_DEFAULT_HEIGHT);
const terminalDragging = ref(false);
const terminalPanelEl = ref<HTMLElement | null>(null);
function applyTerminalHeightLive(height: number): void {
  terminalPanelEl.value?.style.setProperty('--terminal-h', `${height}px`);
}
watch(
  [terminalPanelEl, terminalHeight],
  ([el, h]) => el?.style.setProperty('--terminal-h', `${h}px`),
  { immediate: true },
);
function onTerminalWindowResize(): void {
  viewportHeight.value = window.innerHeight;
  const clamped = Math.min(terminalMax.value, terminalHeight.value);
  if (clamped !== terminalHeight.value) {
    terminalHeight.value = clamped;
  }
}

const conversationPaneRef = ref<InstanceType<typeof ConversationPane> | null>(null);
const panelTabsRef = ref<InstanceType<typeof PanelTabs> | null>(null);

function openSessionInfoTab(type: PanelLauncherType): void {
  void panelTabsRef.value?.openLauncherTab(type);
}

const { contextInspectorEnabled } = useContextInspector();
const disabledContextTabIds = computed(() =>
  contextInspectorEnabled.value
    ? []
    : panel.panelTabs.value.filter((tab) => tab.type === 'context').map((tab) => tab.id),
);
watch(disabledContextTabIds, reapPanelTabs, { immediate: true });

function armSideChatFocus(): { acted: () => boolean; focusWhenReady: () => void } {
  let userActed = false;
  const onUserAction = (e: Event): void => {
    if (e instanceof KeyboardEvent && e.repeat) return;
    userActed = true;
    panel.bumpInteractionVersion();
  };
  document.addEventListener('pointerdown', onUserAction, true);
  document.addEventListener('keydown', onUserAction, true);
  window.addEventListener('blur', onUserAction);
  document.addEventListener('visibilitychange', onUserAction);
  return {
    acted: () => userActed,
    focusWhenReady: () => {
      void nextTick(() => {
        document.removeEventListener('pointerdown', onUserAction, true);
        document.removeEventListener('keydown', onUserAction, true);
        window.removeEventListener('blur', onUserAction);
        document.removeEventListener('visibilitychange', onUserAction);
        if (userActed) return;
        if (!document.hasFocus()) return;
        if (isMobile.value) return;
        if (anyOverlayOpen.value) return;
        panelTabsRef.value?.focusSideChatInput();
      });
    },
  };
}

const mobileGoalActive = computed(() => {
  const s = client.goal.value?.status;
  return s === 'active' || s === 'paused' || s === 'blocked';
});
function onMobileFocusGoal(): void {
  showMobileSettings.value = false;
  conversationPaneRef.value?.focusGoal();
}

const {
  showOnboarding,
  showMobileSwitcher,
  showMobileSettings,
  showModelPicker,
  showLogin,
  showAddWorkspace,
  showStatusPanel,
  showSettings,
  authRequired,
  showServerAuth,
  settingsInitialTab,
  mobileSettingsInitialTab,
  settingsHighlightKey,
  modelPickerTargetSid,
  modelsLoading,
  modelsUnavailable,
  configSaving,
  addWorkspaceError,
  pendingWorkspaceSubmit,
  anyOverlayOpen: interruptiveOverlayOpen,
  completeOnboarding,
  handleWizardAddProvider,
  openModelPicker,
  openLogin,
  openProviderSettings,
  openHostSettings,
  dropPendingWorkspaceSubmit,
  completeWorkspaceCreation,
  addWorkspace,
  handleCloseAddWorkspace,
  handleLoginSuccess,
} = useAppDialogs({
  restorePendingComposer: (pending, sessionId) => {
    restoreDraftAtOrigin(
      sessionId,
      pending.prompt.text,
      pending.prompt.attachments,
      pending.restoreText,
      pending.restoreEntries,
      pending.prompt.snapshot,
    );
  },
  beforePendingPromptSend: (pending) => {
    conversationPaneRef.value?.clearComposerAfterDispatch(pending.prompt.snapshot);
  },
  onWorkspaceAdded: () => {
    track('workspace_added', { workspace_count: client.workspacesView.value.length });
    terminalStore.destroySession(terminalBucketKey('', null));
  },
});

const offQuitConfirm = useQuitConfirm({
  confirm,
  cancelCurrent: () => settleConfirm(false),
  isBusy: () => confirmBusy.value,
  isOverlayOpen: () => interruptiveOverlayOpen.value,
  t: (key, params) => (params === undefined ? t(key) : t(key, params)),
});
onUnmounted(offQuitConfirm);

const settingsBrowserSection = ref<BrowserSettingsSection>('settings');
const browserSettingsRequested = ref(false);
watch(showSettings, (open) => {
  if (!open) browserSettingsRequested.value = false;
});

const settingsShortcutAction = ref<ShortcutActionId>();
provide(OpenShortcutSettingsKey, (action) => {
  settingsShortcutAction.value = action;
  showSettings.value = true;
});
watch(showSettings, (open) => {
  if (!open) settingsShortcutAction.value = undefined;
});

type SubmitPayload = {
  text: string;
  attachments: PromptAttachment[];
  restoreText?: string;
  editText?: string;
  restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot;
  skills?: { name: string; path?: string }[];
  forceQueue?: boolean;
};
const forcedUpgradeVisible = ref(false);
const feedbackEnabled = computed(() => client.experimentalFlags.value['desktop_feedback'] === true);
const globalFeedbackTarget = ref<GlobalFeedbackTarget | null>(null);
const desktopFeedback = useDesktopFeedback({
  signedIn: () => signedIn.value,
  accountId: () => managedUserInfo.value?.userId,
  openLogin,
  sessionHost: (sessionId) => sessionsStore().sessions.find((session) => session.id === sessionId)?.hostId
    ?? (sessionId === activeSessionId.value ? client.visibleWorkspace.value?.hostId : undefined),
  hostAccounts: () => hostsStore().accounts,
  hostUserId: async (hostId) => {
    const account = await getDeviceApi(hostId).getUserInfo();
    return account.kind === 'ok' ? account.userInfo.userId : undefined;
  },
  openHostLogin: (hostId) => hostsStore().openLogin(hostId),
});
provide(DesktopFeedbackKey, desktopFeedback);
watch(desktopFeedback.accountEpoch, () => { globalFeedbackTarget.value = null; }, { flush: 'sync' });

function openGlobalFeedback(source: GlobalFeedbackTarget['source']): void {
  if (!feedbackEnabled.value || globalFeedbackTarget.value !== null || !desktopFeedback.requireLogin()) return;
  desktopFeedback.closePopover();
  const hasConversation = mainView.value === 'chat' && client.turns.value.some((turn) => turn.role === 'user');
  globalFeedbackTarget.value = {
    source,
    sessionId: hasConversation ? activeSessionId.value ?? undefined : undefined,
  };
}

const anyOverlayOpen = computed<boolean>(
  () => interruptiveOverlayOpen.value || isConfirmOpen.value || forcedUpgradeVisible.value || globalFeedbackTarget.value !== null,
);
watch([activeSessionId, mainView, signedIn, anyOverlayOpen], () => desktopFeedback.closePopover());
const selectionContextMenuBridge = (window as { kimiDesktop?: { showSelectionContextMenu?: (selectionText: string) => void } }).kimiDesktop;
if (selectionContextMenuBridge?.showSelectionContextMenu !== undefined) {
  provide(SelectionContextMenuKey, (selectionText) => selectionContextMenuBridge.showSelectionContextMenu?.(selectionText));
}
if (desktopBridge) {
  provide(
    SessionRatingKey,
    enableSessionRating({
      canPrompt: () =>
        !anyOverlayOpen.value && conversationPaneRef.value?.composerPopupOpen() !== true,
    }),
  );
}
const browserConfirmUsesNativeSurface = computed(
  () =>
    !isMobile.value &&
    canUseBrowserOverlayDialog() &&
    panel.panelVisible.value &&
    panel.activeTab.value?.type === 'browser',
);
const browserOccluded = computed(() => interruptiveOverlayOpen.value || globalFeedbackTarget.value !== null);


async function confirmLogout(): Promise<void> {
  await confirm({
    title: t('sidebar.logoutConfirmTitle'),
    message: t('sidebar.logoutConfirmMessage'),
    variant: 'danger',
    action: async () => {
      await client.logout();
      refreshUpgradeRegion();
    },
  });
}

function openBrowserSettings(section: BrowserSettingsSection): void {
  settingsInitialTab.value = undefined;
  browserSettingsRequested.value = true;
  settingsBrowserSection.value = section;
  showSettings.value = true;
}

async function openBrowserUrlFromSettings(url: string): Promise<void> {
  showSettings.value = false;
  settingsInitialTab.value = undefined;
  settingsBrowserSection.value = 'settings';
  await nextTick();
  await panelTabsRef.value?.openBrowserUrl(url);
}

provide(OpenFileLinkKey, (target, open) => openFileOrLocalHtml(target, localHtmlOpener, client.status.value.cwd, open));
provide(OpenLocalHtmlFileKey, localHtmlLinkHandler(localHtmlOpener, (target) => panel.openFilePreview(target), closeDockWorkPanel));
provide(OpenHtmlFileInPanelKey, () => {
  if (!canOpenBrowserTab.value) return undefined;
  localPagesCapability.probe();
  if (!localPagesCapability.allowed.value) return undefined;
  return (target) => {
    reportLocalHtmlOpenFailure(
      localHtmlOpener.open(target.path, target.urlSuffix),
      () => warningsStore().pushWarning({ severity: 'error', title: t('filePreview.openFailed') }),
    );
  };
});

provide(OpenSidebarBrowserUrlKey, () => {
  if (!canOpenBrowserTab.value) return undefined;
  return (url) => {
    void panelTabsRef.value?.openBrowserUrl(url);
  };
});

async function handleSelectModel(modelId: string): Promise<void> {
  showModelPicker.value = false;
  const targetSid = modelPickerTargetSid.value;
  modelPickerTargetSid.value = undefined;
  if (targetSid !== undefined && targetSid !== (client.activeSessionId.value ?? undefined)) {
    const switched = await client.setSessionModel(targetSid, modelId);
    if (switched && modelId !== defaultModel.value) {
      void client.updateConfig({ defaultModel: modelId });
    }
    return;
  }
  await client.selectModel(modelId);
}

function onAttachmentOpen(target: { url: string; fileId?: string; name: string; mediaType?: string; kind?: string; sessionId?: string }): void {
  if (target.kind === 'image' || target.kind === 'video') {
    const media = { kind: target.kind, url: target.url, name: target.name, fileId: target.fileId, sessionId: target.sessionId } as ToolMedia;
    const gallery = collectTurnAttachmentImages(client.turns.value, (turn) => {
      const snapshot = composerSnapshotFromMetadata(turn.clientMetadata);
      return new Set(
        (snapshot?.attachments ?? [])
          .filter((entry) => entry.purpose === 'browser-screenshot')
          .map((entry) => `${entry.sessionId ?? ''}:${entry.fileId}`),
      );
    });
    const inGallery = gallery.some(
      (item) =>
        (media.fileId !== undefined && item.fileId === media.fileId && item.sessionId === media.sessionId) ||
        (media.url !== '' && item.url === media.url),
    );
    onOpenMedia({ media, images: inGallery ? gallery : undefined });
    return;
  }
  const fileId = target.fileId;
  if (fileId === undefined) return;
  void openFileAttachment(getKimiWebApi(), fileId, target.name, target.mediaType).then((result) => {
    if (result !== 'unsupported') return;
    client.showActionToast({ kind: 'attachmentOpen', name: target.name || fileId });
  });
}

const { sessionAdminBatchRunning, runSessionAdminBatch } = useSessionAdminBatch();

async function confirmDeleteWorkspace(id: string): Promise<void> {
  const sessionIds = client.sessions.value
    .filter((s) => workspaces.sessionBelongsToWorkspace(s, id))
    .map((s) => s.id);
  const confirmed = await confirm({
    title: t('sidebar.removeWorkspace'),
    message: workspaces.removeWorkspaceMessage(id, t),
    confirmLabel: t('workspace.removeAction'),
    variant: 'danger',
    action: async () => {
      await client.deleteWorkspace(id);
    },
  });
  if (!confirmed) return;
  if (client.workspacesView.value.some((w) => w.id === id)) return;
  for (const sessionId of sessionIds) {
    terminalStore.destroySession(sessionId);
  }
  terminalStore.destroySession(terminalBucketKey('', id));
}

async function handleUpdateConfig(patch: Partial<AppConfig>): Promise<void> {
  configSaving.value = true;
  try {
    const saved = await client.updateConfig(patch);
    if (saved) {
      await client.checkAuth();
    }
  } finally {
    configSaving.value = false;
  }
}

async function handleStartOAuthLogin(region?: OAuthRegion) {
  return client.startOAuthLogin(region);
}

async function handlePollOAuthLogin() {
  return client.pollOAuthLogin();
}

async function handleCancelOAuthLogin() {
  return client.cancelOAuthLogin();
}

async function handleGetOAuthRegion() {
  return client.getOAuthRegion();
}

const hostLoginId = computed(() => hostsStore().loginHostId);
function finishHostLogin(hostId: string): void {
  desktopFeedback.clearHostAccount(hostId);
  hostsStore().finishLogin();
}
const hostLoginTitle = computed(() => {
  const hostId = hostLoginId.value;
  return hostId === null ? undefined : t('login.hostTitle', { name: hostsStore().hostLabel(hostId, t) });
});

async function handleWizardLoginSuccess(): Promise<void> {
  completeOnboarding();
  await client.checkAuth();
  await client.load();
  refreshUpgradeRegion();
}

async function handleEditMessage(payload: {
  text: string;
  attachments?: TurnAttachment[];
  turnId: string;
  snapshot?: ComposerDocumentSnapshot;
}): Promise<void> {
  const result = await client.undo(payload.turnId);
  if (result === null) return;
  await nextTick();
  conversationPaneRef.value?.loadComposerForEdit(payload.text, payload.attachments, undefined, payload.snapshot);
  conversationPaneRef.value?.notifyUndone();
}

async function handleInterrupt(): Promise<void> {
  await client.abortCurrentPrompt();
}

async function handleContinue(): Promise<void> {
  const gateSid = client.activeSessionId.value;
  if (!gateSid) return;
  const verdict = await client.ensureChatReady();
  if (verdict !== 'ok') {
    if (verdict !== 'server-auth-required') await actOnGateVerdict(verdict);
    return;
  }
  if (client.activeSessionId.value !== gateSid) return;
  ++sendGeneration;
  await client.continueSession(gateSid);
}

const pendingQuoteInserts = ref<Array<{ quote: string; comment?: string; source?: string; sessionId: string | undefined }>>([]);
watch(
  () => [client.activeSessionId.value, conversationPaneRef.value?.hasInsertableComposer() ?? false] as const,
  ([sid, ready]) => {
    if (pendingQuoteInserts.value.length === 0) return;
    pendingQuoteInserts.value = sweepPendingQuotes(pendingQuoteInserts.value, sid, (item) => {
      if (!ready) return false;
      return conversationPaneRef.value?.insertComposerQuote(item.quote, item.comment, item.source) === true;
    });
  },
);

function handleQuoteAction(payload: SelectionActionPayload, quoteSource?: string): void {
  const comment = payload.action === 'comment' ? payload.comment : undefined;
  if (conversationPaneRef.value?.insertComposerQuote(payload.quote, comment, quoteSource) !== true) {
    pendingQuoteInserts.value = [
      ...pendingQuoteInserts.value,
      { quote: payload.quote, comment, source: quoteSource, sessionId: client.activeSessionId.value },
    ];
  }
}

type ScreenshotCaptureBridgeResult =
  | { status: 'ok'; pngBytes: Uint8Array; comment: string; captureId: string }
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'denied' }
  | { status: 'error'; reason: string; captureId?: string };

let screenshotInFlight = false;
let awaitingHotkeyScreenshotResult = false;
let hotkeyScreenshotTargetSessionId: string | undefined;
let lastConsumedScreenshotCaptureId: string | undefined;
const pendingScreenshotInserts = ref<Array<{ file: File; comment: string; sessionId: string | undefined }>>([]);

watch(
  () => [client.activeSessionId.value, conversationPaneRef.value?.hasInsertableComposer() ?? false, client.sessions.value.map((session) => session.id).join('\n')] as const,
  ([sid, ready, sessionIds]) => {
    if (pendingScreenshotInserts.value.length === 0) return;
    const known = new Set(sessionIds.split('\n').filter(Boolean));
    const remaining: typeof pendingScreenshotInserts.value = [];
    for (const item of pendingScreenshotInserts.value) {
      if (item.sessionId !== undefined && !known.has(item.sessionId)) {
        client.notify({ severity: 'warning', title: t('composer.screenshotSessionGone') });
        continue;
      }
      if (!ready || item.sessionId !== sid) {
        remaining.push(item);
        continue;
      }
      if (conversationPaneRef.value?.insertScreenshotAnnotation(item.file, item.comment) !== true) remaining.push(item);
    }
    pendingScreenshotInserts.value = remaining;
  },
);

function consumeScreenshotResult(result: ScreenshotCaptureBridgeResult, targetSessionId: string | undefined): void {
  const captureId = result.status === 'ok' ? result.captureId : result.status === 'error' ? result.captureId : undefined;
  if (captureId !== undefined && captureId !== '' && captureId === lastConsumedScreenshotCaptureId) return;
  if (captureId !== undefined && captureId !== '') lastConsumedScreenshotCaptureId = captureId;
  if (result.status === 'ok') {
    const bytes = new Uint8Array(result.pngBytes.byteLength);
    bytes.set(result.pngBytes);
    const file = new File([bytes.buffer], `screenshot-${Date.now()}.png`, { type: 'image/png' });
    const comment = result.comment.trim();
    const canInsertNow = targetSessionId === client.activeSessionId.value
      && conversationPaneRef.value?.hasInsertableComposer() === true;
    if (!canInsertNow || conversationPaneRef.value?.insertScreenshotAnnotation(file, comment) !== true) {
      pendingScreenshotInserts.value = [
        ...pendingScreenshotInserts.value,
        { file, comment, sessionId: targetSessionId },
      ];
    } else {
      conversationPaneRef.value?.focusComposer();
    }
  } else if (result.status === 'error') {
    client.notify({ severity: 'warning', title: t('composer.screenshotFailed') });
  }
}

async function handleScreenshot(): Promise<void> {
  const bridge = (
    window as { kimiDesktop?: { captureScreenshot?: () => Promise<ScreenshotCaptureBridgeResult> } }
  ).kimiDesktop;
  if (typeof bridge?.captureScreenshot !== 'function' || screenshotInFlight) return;
  const targetSessionId = client.activeSessionId.value;
  screenshotInFlight = true;
  try {
    consumeScreenshotResult(await bridge.captureScreenshot(), targetSessionId);
  } finally {
    screenshotInFlight = false;
  }
}

function armHotkeyScreenshot(): void {
  hotkeyScreenshotTargetSessionId = client.activeSessionId.value;
  awaitingHotkeyScreenshotResult = true;
}

function consumeHotkeyScreenshotResult(result: ScreenshotCaptureBridgeResult): void {
  if (!awaitingHotkeyScreenshotResult) return;
  awaitingHotkeyScreenshotResult = false;
  if (screenshotInFlight) return;
  consumeScreenshotResult(result, hotkeyScreenshotTargetSessionId);
}

const previewPanelRootEl = computed(() => panelTabsRef.value?.rootEl ?? null);
const activeQuotePath = computed(() => {
  const active = panel.activeTab.value;
  if (active?.type === 'file') return (active.payload as FileTabPayload).path;
  if (active?.type === 'files') {
    const sid = client.activeSessionId.value;
    return sid ? (filesStore().filePreviewTargetOf(sid)?.path ?? undefined) : undefined;
  }
  if (active?.type === 'diff') return client.selectedDiffPath.value ?? undefined;
  if (active?.type === 'turn-diff') return (active.payload as TurnDiffTabPayload).change.path;
  return undefined;
});
const {
  selectionBubble: previewSelectionBubble,
  selectionKeyboard: previewSelectionKeyboard,
  onMouseup: onPreviewQuoteMouseup,
  onPointerdown: onPreviewQuotePointerdown,
  onBubbleClose: onPreviewQuoteBubbleClose,
  onBubbleAction: onPreviewQuoteBubbleAction,
} = useSelectionQuoteBubble({
  root: previewPanelRootEl,
  containerSelector: PANEL_QUOTE_CONTAINER,
  captureSource: (sel) => captureQuoteSource(sel, activeQuotePath.value ?? ''),
  onAction: (payload, source) => {
    handleQuoteAction(payload, source);
    if (isMobile.value) panel.hidePanel();
  },
});

watch(
  () => [panel.activeTabId.value, panel.panelVisible.value, panel.panelExpanded.value],
  () => {
    onPreviewQuoteBubbleClose();
  },
);

function toEditableAttachments(atts: PromptAttachment[]): TurnAttachment[] {
  const api = getKimiWebApi();
  return atts.map((a) => promptAttachmentToTurnAttachment(api, a));
}

async function actOnGateVerdict(verdict: ChatGateVerdict, restore?: () => void, targetSid?: string): Promise<void> {
  if (verdict === 'ok') return;
  const copy =
    verdict === 'login'
      ? { title: t('login.requiredTitle'), message: t('login.requiredMessage'), confirmLabel: t('login.goToLogin') }
      : verdict === 'upgrade'
        ? { title: t('login.upgradeRequiredTitle'), message: t('login.upgradeRequiredMessage'), confirmLabel: t('login.upgradeNow') }
        : verdict === 'pick-model'
          ? { title: t('login.pickModelTitle'), message: t('login.pickModelMessage'), confirmLabel: t('login.pickModelAction') }
          : {
              title: t('login.configureModelsTitle'),
              message: signedIn.value ? t('login.configureModelsMessage') : t('login.configureModelsGenericMessage'),
              confirmLabel: t('login.configureModelsAction'),
            };
  const confirmed = await confirm({ ...copy, variant: 'primary' });
  restore?.();
  if (!confirmed) return;
  if (verdict === 'login') openLogin();
  else if (verdict === 'upgrade') openUpgrade();
  else if (verdict === 'pick-model') void openModelPicker(targetSid);
  else openProviderSettings();
}

watch([client.sendFailureVerdict, isConfirmOpen], ([payload, confirmOpen]) => {
  if (payload === null || payload.verdict === 'ok') return;
  if (confirmOpen) return;
  client.dismissSendFailureVerdict();
  void actOnGateVerdict(payload.verdict, undefined, payload.sessionId);
});

async function passAuthGate(text: string, attachments: PromptAttachment[], restoreText?: string, restoreEntries?: AttachmentEntry[], snapshot?: ComposerDocumentSnapshot): Promise<boolean> {
  const originSid = client.activeSessionId.value ?? undefined;
  const verdict = await client.ensureChatReady();
  if (verdict === 'ok') return true;
  if (verdict === 'server-auth-required') {
    restoreDraftAtOrigin(originSid, text, attachments, restoreText, restoreEntries, snapshot);
    return false;
  }
  await actOnGateVerdict(verdict, () =>
    restoreDraftAtOrigin(originSid, text, attachments, restoreText, restoreEntries, snapshot),
  );
  return false;
}

async function passWorkspaceGateForCommand(text: string, attachments: PromptAttachment[] = [], restoreText?: string, restoreEntries?: AttachmentEntry[], snapshot?: ComposerDocumentSnapshot): Promise<boolean> {
  if (client.activeSessionId.value || client.activeWorkspaceId.value) return true;
  const pick = await confirm({
    title: t('workspace.requiredTitle'),
    message: t('workspace.requiredMessage'),
    confirmLabel: t('conversation.addWorkspace'),
    variant: 'primary',
  });
  conversationPaneRef.value?.loadComposerForEdit(restoreText ?? text, toEditableAttachments(attachments), restoreEntries, snapshot);
  if (pick) requestWorkspaceDialog();
  return false;
}

async function passCommandGates(text: string, attachments: PromptAttachment[] = [], restoreText?: string, restoreEntries?: AttachmentEntry[], snapshot?: ComposerDocumentSnapshot): Promise<boolean> {
  const originSid = client.activeSessionId.value;
  const originWsId = client.activeWorkspaceId.value;
  if (!(await passAuthGate(text, attachments, restoreText, restoreEntries, snapshot))) return false;
  if (!(await passWorkspaceGateForCommand(text, attachments, restoreText, restoreEntries, snapshot))) return false;
  if (client.activeSessionId.value !== originSid || client.activeWorkspaceId.value !== originWsId) {
    restoreDraftAtOrigin(originSid ?? undefined, text, attachments, restoreText, restoreEntries, snapshot);
    return false;
  }
  if (!useWorkspaceTrust().gateSubmitForTrust()) {
    restoreDraftAtOrigin(originSid ?? undefined, text, attachments, restoreText, restoreEntries, snapshot);
    return false;
  }
  return true;
}

let sendGeneration = 0;

// `/tower` UI entries show only while the DAEMON reports the experimental
// flag on (GET /meta — the daemon already resolved its env/config into this;
// there is no client-side config fallback). Anything still attempted (typed
// command, stale row) fails the enable write server-side and toasts the
// daemon's own error.
const towerEnabled = computed(() => client.experimentalFlags.value['tower'] === true);

// Mobile settings sheet's tower toggle: the sheet hides the row while the
// flag is off, so this only forwards.
function onToggleTower(): void {
  void client.toggleTowerMode();
}

async function handleCommand(payload: { cmd: string; attachments: PromptAttachment[]; restoreText?: string; skillName?: string; skillPath?: string; restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot; editText?: string; delivery?: 'steer' | 'queue' }): Promise<void> {
  const { cmd, attachments, restoreText, restoreEntries, snapshot } = payload;
  if (cmd === '/feedback' && feedbackEnabled.value && payload.skillName === undefined) {
    openGlobalFeedback('command');
    return;
  }
  if (cmd === '/compact' || cmd.startsWith('/compact ')) {
    if (!(await passCommandGates(cmd, [], restoreText, restoreEntries, snapshot))) return;
    const result = client.compact(commandArgumentText(cmd, snapshot) || undefined);
    if (result === undefined) {
      conversationPaneRef.value?.loadComposerForEdit(restoreText ?? cmd, toEditableAttachments(attachments), restoreEntries, snapshot);
      client.notify({ severity: 'warning', title: t('commands.compact.requiresSession') });
      return;
    }
    if (result === 'queued') {
      client.notify({ severity: 'info', title: t('commands.compactQueue.queued') });
    } else if (result === 'duplicate' || result === 'compacting') {
      conversationPaneRef.value?.loadComposerForEdit(restoreText ?? cmd, toEditableAttachments(attachments), restoreEntries, snapshot);
      client.notify({
        severity: 'warning',
        title: t(result === 'duplicate' ? 'commands.compactQueue.alreadyQueued' : 'commands.compactQueue.compacting'),
      });
    }
    return;
  }
  if (cmd === '/swarm' || cmd.startsWith('/swarm ')) {
    const arg = cmd.slice('/swarm'.length).trim();
    if (arg === 'on') client.setSwarmMode(true);
    else if (arg === 'off') client.setSwarmMode(false);
    else if (arg) {
      const originSid = client.activeSessionId.value;
      if (!(await passCommandGates(cmd, attachments, restoreText, restoreEntries, snapshot))) return;
      client.setSwarmMode(true);
      const prompt = client.createPromptEnvelope(commandPromptContent(cmd, attachments, snapshot));
      if (payload.delivery === 'steer') {
        const generation = ++sendGeneration;
        const outcome = await client.steerPromptDirect(prompt, originSid ?? undefined);
        if (outcome === 'rejected') restoreDraftAfterFailedSend(generation, originSid ?? undefined, cmd, attachments, restoreText, restoreEntries, snapshot);
        return;
      }
      const forceQueue = payload.delivery === 'queue';
      const generation =
        forceQueue || (client.wouldEnqueuePrompt() && !client.wouldSteerPrompt())
          ? sendGeneration
          : ++sendGeneration;
      const sid = client.activeSessionId.value;
      const outcome = await client.sendPrompt(
        prompt,
        payload.editText,
        forceQueue ? { recoverConflicts: true, forceQueue: true } : undefined,
      );
      if (outcome === 'rejected') restoreDraftAfterFailedSend(generation, sid ?? undefined, cmd, attachments, restoreText, restoreEntries, snapshot);
    }
    else void client.toggleSwarmMode();
    return;
  }
  if (cmd === '/tower' || cmd.startsWith('/tower ')) {
    const arg = cmd.slice('/tower'.length).trim();
    if (arg === 'on') {
      void client.setTowerMode(true);
    } else if (arg === 'off') {
      void client.setTowerMode(false);
    } else if (arg === '') {
      void client.toggleTowerMode();
    } else if (arg === 'status') {
      if (!(await passCommandGates(cmd, [], restoreText, restoreEntries, snapshot))) return;
      ++sendGeneration;
      void client.sendTowerPrompt(TOWER_STATUS_PROMPT);
    } else if (arg === 'teardown') {
      if (!(await passCommandGates(cmd, [], restoreText, restoreEntries, snapshot))) return;
      ++sendGeneration;
      void client.sendTowerPrompt(TOWER_TEARDOWN_PROMPT);
    } else {
      void client.setTowerMode(true, commandArgumentText(cmd, snapshot));
    }
    return;
  }
  if (cmd === '/goal' || cmd.startsWith('/goal ')) {
    const arg = cmd.slice('/goal'.length).trim();
    if (arg === 'pause' || arg === 'resume' || arg === 'cancel') client.controlGoal(arg);
    else if (arg) {
      if (!(await passCommandGates(cmd, attachments, restoreText, restoreEntries, snapshot))) return;
      const forceQueue = payload.delivery === 'queue';
      const generation =
        forceQueue || (payload.delivery !== 'steer' && client.wouldEnqueuePrompt() && !client.wouldSteerPrompt())
          ? sendGeneration
          : ++sendGeneration;
      const started = await client.createGoal(
        commandPromptContent(cmd, attachments, snapshot),
        payload.delivery || payload.editText
          ? { delivery: payload.delivery, editText: payload.editText }
          : undefined,
      );
      if (started.promptRejected || started.sessionId === null) {
        restoreDraftAfterFailedSend(generation, started.sessionId ?? undefined, cmd, attachments, restoreText, restoreEntries, snapshot);
      }
    }
    else client.toggleGoalMode();
    return;
  }
  if (cmd === '/btw' || cmd.startsWith('/btw ')) {
    if (!client.activeSessionId.value) {
      conversationPaneRef.value?.loadComposerForEdit(restoreText ?? cmd, toEditableAttachments(attachments), restoreEntries, snapshot);
      client.notify({ severity: 'warning', title: t('sideChat.requiresSession') });
      return;
    }
    const arg = cmd.slice('/btw'.length).trim();
    if (!arg) {
      toggleBtwPanel();
    } else {
      const sideChatFocus = armSideChatFocus();
      if (!(await passCommandGates(cmd, attachments, restoreText, restoreEntries, snapshot))) {
        sideChatFocus.focusWhenReady();
        return;
      }
      const generation = ++sendGeneration;
      try {
        const result = await panel.openSideChatTab(commandPromptContent(cmd, attachments, snapshot));
        if (!result.sent) restoreDraftAfterFailedSend(generation, result.sessionId ?? undefined, cmd, attachments, restoreText, restoreEntries, snapshot);
      } finally { sideChatFocus.focusWhenReady(); }
    }
    return;
  }
  switch (cmd) {
    case '/new':
    case '/clear':
      setSessionIntent('slash_command');
      handleCreateSession();
      break;
    case '/fork':
      void client.forkSession();
      break;
    case '/reload':
      track('session_menu_action', { action: 'reload' });
      void client.reloadSession();
      break;
    case '/export':
      void client.exportSessionWithToast();
      break;
    case '/undo':
      void client.undo();
      break;
    case '/status':
      showStatusPanel.value = true;
      break;
    case '/login':
      openLogin();
      break;
    default: {
      const space = cmd.indexOf(' ');
      const name = payload.skillName ?? stripSkillPrefix((space === -1 ? cmd : cmd.slice(0, space)).slice(1));
      const args = payload.skillName
        ? skillCommandArgs(cmd, payload.skillName, restoreText)
        : space === -1
          ? undefined
          : cmd.slice(space + 1).trim() || undefined;
      if (!name) break;
      const generation = ++sendGeneration;
      if (!(await passCommandGates(cmd, attachments, restoreText, restoreEntries, snapshot))) return;
      if (!client.activeSessionId.value && client.activeWorkspaceId.value) {
        const workspaceId = client.activeWorkspaceId.value;
        const { sessionId: createdId, activated } = await client.startSessionAndActivateSkill(
          workspaceId,
          name,
          args,
          attachments,
          snapshot,
          payload.skillPath,
        );
        if (!activated && (createdId !== null || client.activeWorkspaceId.value === workspaceId)) {
          restoreDraftAfterFailedSend(generation, createdId ?? undefined, cmd, attachments, restoreText, restoreEntries, snapshot);
        }
      } else {
        const sid = client.activeSessionId.value;
        void client.activateSkill(name, args, attachments, undefined, { snapshot, skillPath: payload.skillPath }).then((ok) => {
          if (ok) return;
          restoreDraftAfterFailedSend(generation, sid ?? undefined, cmd, attachments, restoreText, restoreEntries, snapshot);
        });
      }
      break;
    }
  }
}

let promptDispatchInFlight = 0;
let promptDispatchSequence = 0;

function beginPromptDispatch(): number {
  promptDispatchInFlight = ++promptDispatchSequence;
  return promptDispatchInFlight;
}

function releasePromptDispatch(owner: number): void {
  if (promptDispatchInFlight === owner) promptDispatchInFlight = 0;
}

async function handleSteer(payload: { text: string; attachments: PromptAttachment[]; restoreText?: string; restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot; skills?: { name: string; path?: string }[] }): Promise<void> {
  if (promptDispatchInFlight !== 0) return;
  const owner = beginPromptDispatch();
  try {
    await handleSteerDispatch(payload, owner);
  } finally {
    releasePromptDispatch(owner);
  }
}

async function handleSteerDispatch(payload: { text: string; attachments: PromptAttachment[]; restoreText?: string; restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot; skills?: { name: string; path?: string }[] }, owner: number): Promise<void> {
  const generation = ++sendGeneration;
  const gateSid = client.activeSessionId.value;
  const restore = () => {
    if (generation === sendGeneration) restoreDraftAtOrigin(gateSid ?? undefined, payload.text, payload.attachments, payload.restoreText, payload.restoreEntries, payload.snapshot);
  };
  const verdict = await client.ensureChatReady();
  if (verdict !== 'ok') {
    if (verdict !== 'server-auth-required') await actOnGateVerdict(verdict);
    restore();
    return;
  }
  if ((client.activeSessionId.value ?? undefined) !== gateSid) { restore(); return; }
  const prompt = client.createPromptEnvelope({ text: payload.text, attachments: payload.attachments, skills: payload.skills, snapshot: payload.snapshot });
  releasePromptDispatch(owner);
  conversationPaneRef.value?.clearComposerAfterDispatch(payload.snapshot);
  const outcome = await client.steerPromptDirect(prompt);
  if (outcome === 'rejected') restoreDraftAfterFailedSend(generation, gateSid ?? undefined, payload.text, payload.attachments, payload.restoreText, payload.restoreEntries, payload.snapshot);
}

async function handleSteerQueued(index: number): Promise<void> {
  const gateSid = client.activeSessionId.value ?? undefined;
  const verdict = await client.ensureChatReady();
  if (verdict !== 'ok') {
    if (verdict !== 'server-auth-required') await actOnGateVerdict(verdict);
    return;
  }
  if ((client.activeSessionId.value ?? undefined) !== gateSid) return;
  sendGeneration++;
  void client.steerQueued(index);
}

function restoreDraftAtOrigin(originSid: string | undefined, text: string, attachments: PromptAttachment[], restoreText?: string, restoreEntries?: AttachmentEntry[], snapshot?: ComposerDocumentSnapshot): void {
  restoreSendDraftAtOrigin(originSid || undefined, { text: restoreText ?? text, attachments, restoreEntries, snapshot }, {
    activeSessionId: () => client.activeSessionId.value || undefined,
    composer: () => {
      const pane = conversationPaneRef.value;
      if (!pane) return null;
      return {
        isComposerEmpty: () => pane.isComposerEmpty(),
        loadRecoveredDraft: (draft) => pane.loadComposerForEdit(draft.text, toEditableAttachments(draft.attachments ?? []), draft.restoreEntries, draft.snapshot),
      };
    },
  });
}

function restoreDraftAfterFailedSend(generation: number, originSid: string | undefined, text: string, attachments: PromptAttachment[], restoreText?: string, restoreEntries?: AttachmentEntry[], snapshot?: ComposerDocumentSnapshot): void {
  if (generation !== sendGeneration) return;
  restoreDraftAtOrigin(originSid, text, attachments, restoreText, restoreEntries, snapshot);
}

async function handleSubmit(payload: SubmitPayload): Promise<void> {
  if (promptDispatchInFlight !== 0) return;
  const owner = beginPromptDispatch();
  try {
    await handleSubmitDispatch(payload, owner);
  } finally {
    releasePromptDispatch(owner);
  }
}

async function handleSubmitDispatch(payload: SubmitPayload, owner: number): Promise<void> {
  const gateSid = client.activeSessionId.value;
  const gateWsId = client.activeWorkspaceId.value;
  if (!(await passAuthGate(payload.text, payload.attachments, payload.restoreText, payload.restoreEntries, payload.snapshot))) return;
  if (client.activeSessionId.value !== gateSid || client.activeWorkspaceId.value !== gateWsId) {
    restoreDraftAtOrigin(gateSid ?? undefined, payload.text, payload.attachments, payload.restoreText, payload.restoreEntries, payload.snapshot);
    return;
  }
  const prompt = client.createPromptEnvelope({
    text: payload.text,
    attachments: payload.attachments,
    skills: payload.skills,
    snapshot: payload.snapshot,
  });
  const generation =
    payload.forceQueue || (client.wouldEnqueuePrompt() && !client.wouldSteerPrompt())
      ? sendGeneration
      : ++sendGeneration;
  const wsId = client.activeWorkspaceId.value;
  if (!client.activeSessionId.value && wsId) {
    releasePromptDispatch(owner);
    conversationPaneRef.value?.clearComposerAfterDispatch(payload.snapshot);
    const started = await client.startSessionAndSendPrompt(wsId, prompt);
    if (started.promptRejected || (started.sessionId === null && started.concurrent !== true)) {
      restoreDraftAfterFailedSend(generation, started.sessionId ?? undefined, payload.text, payload.attachments, payload.restoreText, payload.restoreEntries, payload.snapshot);
    }
    return;
  }
  if (!client.activeSessionId.value && !wsId) {
    pendingWorkspaceSubmit.value = {
      prompt,
      restoreText: payload.restoreText,
      editText: payload.editText,
      restoreEntries: payload.restoreEntries,
    };
    const pick = await confirm({
      title: t('workspace.requiredTitle'),
      message: t('workspace.requiredMessage'),
      confirmLabel: t('conversation.addWorkspace'),
      variant: 'primary',
    });
    if (pick) {
      requestWorkspaceDialog();
    } else {
      dropPendingWorkspaceSubmit();
    }
    return;
  }
  const sid = client.activeSessionId.value;
  releasePromptDispatch(owner);
  conversationPaneRef.value?.clearComposerAfterDispatch(payload.snapshot);
  const outcome = await client.sendPrompt(
    prompt,
    payload.editText ?? payload.restoreText,
    { recoverConflicts: true, forceQueue: payload.forceQueue },
  );
  if (outcome === 'rejected') restoreDraftAfterFailedSend(generation, sid ?? undefined, payload.text, payload.attachments, payload.restoreText, payload.restoreEntries, payload.snapshot);
}

type WorkspaceDialogState =
  | { mode: 'create'; dirs: string[]; hostId?: string }
  | { mode: 'edit'; id: string; name: string; dirs: string[]; hostId?: string };

const workspaceDialog = ref<WorkspaceDialogState | null>(null);
const workspaceDialogBusy = ref(false);
const remoteHosts = computed(() => hostsStore().hosts);
const {
  folderPickerRequest,
  pickWorkspaceFolders,
  pickRemoteWorkspaceDirs,
  completeWorkspaceFolderPicker,
  cancelWorkspaceFolderPicker,
} = useWorkspaceFolderPicker();

function requestWorkspaceDialog(hostId?: string): void {
  workspaceDialog.value = { mode: 'create', dirs: [], hostId: hostId ?? workspaces.defaultCreateHostId() };
}

function openWorkspaceEditor(ws: WorkspaceView): void {
  const full = workspaces.workspaces.find((w) => w.id === ws.id);
  workspaceDialog.value = {
    mode: 'edit',
    id: ws.id,
    name: full?.name ?? ws.name,
    dirs: [ws.root, ...(full?.additionalDirs ?? [])],
    hostId: ws.hostId,
  };
}

async function importProjectConfigDirs(primary: string, hostId?: string): Promise<string[] | undefined> {
  return workspaces.fetchWorkspaceProjectConfigDirs(primary, hostId);
}

async function pickMoreWorkspaceDirs(): Promise<string[]> {
  return pickWorkspaceDirectoryWithFallback({
    title: t('workspace.dialog.addDirs'),
    fallback: () => pickWorkspaceFolders(),
  });
}

function closeWorkspaceDialog(): void {
  const dialog = workspaceDialog.value;
  workspaceDialog.value = null;
  if (dialog?.mode === 'create') {
    workspaces.resetCreateWorkspaceAttempt();
    dropPendingWorkspaceSubmit();
  }
}

async function onWorkspaceDialogSubmit(payload: { name: string; dirs: string[]; hostId?: string; projectConfigDirs: string[] }): Promise<void> {
  const dialog = workspaceDialog.value;
  if (dialog === null) return;
  workspaceDialogBusy.value = true;
  try {
    if (dialog.mode === 'create') {
      const created = await workspaces.createWorkspace({ paths: payload.dirs, name: payload.name, hostId: payload.hostId });
      if (created === undefined) return;
      await completeWorkspaceCreation();
      track('native_feature_used', { feature: 'workspace_picker' });
    } else {
      const current = workspaces.workspaces.find((w) => w.id === dialog.id);
      const saved = await workspaces.saveWorkspace({
        id: dialog.id,
        ...(payload.name !== (current?.name ?? dialog.name) ? { name: payload.name } : {}),
        additionalDirs: payload.dirs.slice(1),
        primary: payload.dirs[0],
        projectConfigDirs: payload.projectConfigDirs,
      });
      if (!saved) return;
    }
    workspaceDialog.value = null;
  } finally {
    workspaceDialogBusy.value = false;
  }
}

async function handleAddWorkspace(root: string): Promise<void> {
  const added = await addWorkspace(root);
  if (!added) {
    addWorkspaceError.value = t('workspace.addFailed');
    showAddWorkspace.value = true;
  }
}

async function handleDropWorkspacePaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    const added = await addWorkspace(path);
    if (!added) {
      addWorkspaceError.value = t('workspace.addFailed');
      showAddWorkspace.value = true;
      break;
    }
    track('native_feature_used', { feature: 'workspace_drop' });
  }
}

async function openWorkspaceByRoot(root: string, newChat = false): Promise<void> {
  if (newChat) {
    handleCloseAddWorkspace();
    await nextTick();
  }
  const existing = workspaces.openMostRecentWorkspaceByRoot(root, newChat);
  if (existing) {
    if (newChat) focusComposerAfterDraft();
    return;
  }
  const added = newChat ? await client.addWorkspaceByPath(root) : await addWorkspace(root);
  if (!added) {
    addWorkspaceError.value = t('workspace.addFailed');
    showAddWorkspace.value = true;
  } else if (newChat && client.activeWorkspaceId.value) {
    client.openWorkspaceDraft(client.activeWorkspaceId.value, { entry: 'newChat' });
    focusComposerAfterDraft();
  }
}

function focusComposerAfterDraft(): void {
  void nextTick(() => {
    conversationPaneRef.value?.focusComposer();
  });
}

function openSettingsFromButton(): void {
  if (!showSettings.value) runShortcutAction('openSettings', 'button');
}

function setColorSchemeFromSettings(
  scheme: ColorScheme,
  sourcePanel: 'settings' | 'mobile_settings' = 'settings',
): void {
  client.setColorScheme(scheme);
  track('settings_changed', { key: 'theme', value: scheme, source_panel: sourcePanel });
}

function setFontScaleFromSettings(
  scale: FontScale,
  sourcePanel: 'settings' | 'mobile_settings' = 'settings',
): void {
  client.setFontScale(scale);
  track('settings_changed', { key: 'font-size', value: scale, source_panel: sourcePanel });
}

function handleCreateSession(): void {
  if (workspaces.openNewSessionDraft()) focusComposerAfterDraft();
}

function handleCreateSessionInWorkspace(workspaceId: string): void {
  setSessionIntent('sidebar');
  if (client.openWorkspaceDraft(workspaceId, { entry: 'workspace' })) focusComposerAfterDraft();
}

function handleDraftWorkspaceSelect(workspaceId: string): void {
  if (client.openWorkspaceDraft(workspaceId)) focusComposerAfterDraft();
}

function handleSelectSession(selection: {
  sessionId: string;
  source: SessionCreatedSource;
}): void {
  void client.selectSession(selection.sessionId, { source: selection.source }).then(async () => {
    await nextTick();
    if (activeSessionId.value !== selection.sessionId || mainView.value !== 'chat') return;
    const owner = browserApprovalBrowserIds.value.map(browserId => panel.browserTabOwner(browserId)).find(owner => owner?.sessionId === selection.sessionId);
    if (owner && (panel.activeTab.value?.id !== owner.tabId || !panel.panelVisible.value)) showBrowserTab(panel, owner.sessionId, owner.sessionId, owner.tabId);
  });
}

function openPr(url: string): void {
  if (!url) return;
  window.open(url, '_blank', 'noopener');
}
</script>

<template>
  <div class="app-shell">
    <ServerAuthDialog v-if="showServerAuth" />
    <div
      class="app"
      :class="{
        mobile: isMobile,
        'sidebar-collapsed': sidebarCollapsed && !isMobile,
        'macos-desktop': isMacosDesktop,
        'windows-desktop': isWindowsDesktop,
        'custom-titlebar': hasCustomTitleBar,
        vibrancy: isMacosDesktop && vibrancy,
        fullscreen: isFullscreen,
        'panel-expanded': panel.panelExpanded.value,
        'right-panel-open': panel.panelVisible.value,
      }"
      :inert="showOnboarding"
    >
    <CustomTitleBar
      v-if="hasCustomTitleBar"
      :fullscreen="isFullscreen"
      :sidebar-collapsed="sidebarCollapsed"
      @toggle-sidebar="runShortcutAction('toggleSidebar', 'button')"
    />
    <template v-if="!isMobile">
      <Sidebar
        ref="sidebarRef"
        :collapsed="sidebarCollapsed"
        :dragging="sidebarDragging"
        :col-width="sideWidth"
        :feedback-enabled="feedbackEnabled"
        @select="handleSelectSession($event)"
        @create="runShortcutAction('newSession', 'button')"
        @create-in-workspace="handleCreateSessionInWorkspace($event)"
        @add-workspace="requestWorkspaceDialog()"
        @edit-workspace="openWorkspaceEditor($event)"
        @add-workspace-paths="void handleDropWorkspacePaths($event)"
        @generate-title="(id, done) => void regenerateSessionTitle(id).then(done)"
        @delete-workspace="confirmDeleteWorkspace($event)"
        @open-settings="openSettingsFromButton"
        @open-feedback="openGlobalFeedback('sidebar')"
        @login="openLogin"
        @collapse="runShortcutAction('toggleSidebar', 'button')"
      />
      <ResizeHandle
        v-show="!sidebarCollapsed"
        class="side-handle"
        :storage-key="SIDEBAR_WIDTH_KEY"
        :default-width="SIDEBAR_DEFAULT"
        :min="SIDEBAR_MIN"
        :max="sidebarMax"
        @update:width="sessionColWidth = $event"
        @update:dragging="sidebarDragging = $event"
      />
    </template>

    <!-- Mobile navigation: slim top bar (switcher + settings sheets). -->
    <MobileTopBar
      v-else
      :workspace="visibleWorkspace"
      :session-title="sessionViews.activeSessionTitle"
      :status="activeDisplayStatus"
      @open-switcher="showMobileSwitcher = true"
      @open-settings="runShortcutAction('openSettings', 'button')"
    />

    <ConversationPane
      ref="conversationPaneRef"
      v-show="mainView === 'chat'"
      :mobile="isMobile"
      :right-panel-open="panel.panelVisible.value"
      :main-view="mainView"
      :session-id="activeSessionId"
      :status="status"
      :plan-mode="planMode"
      :pending-question-actions="pendingQuestionActions"
      :pending-approval-actions="pendingApprovalActions"
      :queued="queued"
      :working="working"
      :loading-more-error="loadMoreMessagesError"
      :panel-tabs="panel.panelTabs.value"
      :available-tabs="sessionInfoAvailableTabs"
      :feedback-enabled="feedbackEnabled"
      @select-workspace="handleDraftWorkspaceSelect($event)"
      @add-workspace="requestWorkspaceDialog()"
      @open-pr="openPr"
      @open-diff="panel.openDiffDetail"
      @activate-tab="panel.activateTab"
      @open-tab="openSessionInfoTab"
      @show-tabs="panel.showPanel"
      @submit="handleSubmit($event)"
      @steer="handleSteer($event)"
      @login="openLogin()"
      @command="handleCommand"
      @interrupt="handleInterrupt"
      @continue="handleContinue"
      @steer-queued="handleSteerQueued"
      @toggle-pin="togglePinFromHeader"
      @pick-model="openModelPicker()"
      @configure-model="openProviderSettings()"
      @open-media="onOpenMedia"
      @edit-message="handleEditMessage"
      @quote-action="handleQuoteAction"
      @screenshot="handleScreenshot"
    />

    <!-- Session admin page (/admin/sessions): a full-pane main view switched
         with ConversationPane via v-show so the chat keeps its state. -->
    <SessionAdminView
      v-show="mainView === 'sessionAdmin'"
      :batch-running="sessionAdminBatchRunning"
      @archive-sessions="(ids) => void runSessionAdminBatch('archive', ids)"
      @restore-sessions="(ids) => void runSessionAdminBatch('restore', ids)"
    />

    <PanelTabs
      v-if="!isMobile || panel.panelVisible.value || panelHasTermTabs"
      ref="panelTabsRef"
      :panel="panel"
      :sidebar-collapsed="sidebarCollapsed"
      :file-preview="filePreview"
      :open-file="openFileTarget"
      :on-open-media="onOpenMedia"
      :on-open-btw="openBtwFromPanel"
      :on-open-term="openTermTab"
      :can-open-term="canOpenTermTab"
      :can-open-browser="canOpenBrowserTab"
      :browser-occluded="browserOccluded"
      @open-browser-settings="openBrowserSettings"
      :on-quote-action="handleQuoteAction"
      @mouseup="onPreviewQuoteMouseup"
      @pointerdown="onPreviewQuotePointerdown"
    />

    <IconButton
      v-if="!isMobile"
      class="right-panel-toggle"
      size="sm"
      :label="rightPanelToggleLabel"
      :tooltip="rightPanelTooltip.text"
      :keys="rightPanelTooltip.keys"
      :aria-expanded="panel.panelVisible.value"
      @click="toggleRightPanel"
    >
      <Icon :name="panel.panelVisible.value ? 'panel-collapse-right' : 'panel-expand-right'" size="sm" />
      <span v-if="browserOutOfView" class="right-panel-live" aria-hidden="true"><StatusDot status="running" /></span>
    </IconButton>

    <IconButton
      v-if="!isMobile && (isMacosDesktop || (sidebarCollapsed && !hasCustomTitleBar))"
      class="sidebar-toggle-btn"
      size="sm"
      :label="sidebarToggleLabel"
      :tooltip="sidebarToggleTooltip.text"
      :keys="sidebarToggleTooltip.keys"
      @click="runShortcutAction('toggleSidebar', 'button')"
    >
      <Icon :name="sidebarCollapsed ? 'panel-expand' : 'panel-collapse'" />
    </IconButton>

    <!-- New-chat shortcut — web-only while the sidebar is COLLAPSED (the
         expanded sidebar already owns the primary "New chat" button).
         The custom titlebar deliberately keeps this action out. -->
    <IconButton
      v-if="!isMobile && sidebarCollapsed && !hasCustomTitleBar"
      class="new-chat-btn"
      size="sm"
      :label="t('sidebar.newChat')"
      :tooltip="newChatTooltip.text"
      :keys="newChatTooltip.keys"
      @click="runShortcutAction('newSession', 'button')"
    >
      <Icon name="chat-new" />
    </IconButton>

    <!-- Selection quote bubble for the file preview (划词) — teleports to
         body, anchored to a selection inside `.file-preview .fp-body`. The
         transcript's own bubble lives in ChatPane; the two never pop for the
         same selection (each is ownership-gated to its own surface). -->
    <SelectionActionBubble
      :visible="previewSelectionBubble !== null"
      :x="previewSelectionBubble?.x ?? 0"
      :y="previewSelectionBubble?.y ?? 0"
      :bottom="previewSelectionBubble?.bottom ?? 0"
      :px="previewSelectionBubble?.px"
      :py="previewSelectionBubble?.py"
      :quote="previewSelectionBubble?.quote ?? ''"
      :focus-on-open="previewSelectionKeyboard"
      :focus-return-el="previewPanelRootEl"
      :boundary-el="previewPanelRootEl"
      @action="onPreviewQuoteBubbleAction"
      @close="onPreviewQuoteBubbleClose"
    />

    <!-- Desktop-only native terminal: permanent bottom grid row. Kept mounted after
         first open — unmounting would lose xterm scrollback. -->
    <section
      v-if="terminalEverOpened"
      ref="terminalPanelEl"
      class="terminal-panel"
      :class="{ open: terminalOpen, 'no-anim': terminalDragging || terminalSwitching }"
      role="region"
      :aria-label="t('terminal.panelAria')"
      :aria-hidden="!terminalOpen"
      :inert="!terminalOpen"
    >
      <TerminalResizeHandle
        v-if="terminalOpen"
        :storage-key="TERMINAL_HEIGHT_KEY"
        :default-height="TERMINAL_DEFAULT_HEIGHT"
        :min="TERMINAL_MIN"
        :max="terminalMax"
        :aria-label="t('terminal.resizeAria')"
        :apply-live="applyTerminalHeightLive"
        @update:height="terminalHeight = $event"
        @update:dragging="terminalDragging = $event"
      />
      <TerminalPanel :cwd="terminalCwd" @quote-action="handleQuoteAction" @move-to-panel="moveTerminalToPanel" />
    </section>

    <TerminalDropZone v-if="terminalStore.available && !isMobile" />

    <!-- Model Picker overlay -->
    <ModelPicker
      v-if="showModelPicker"
      :models="activeModels"
      :current="status.modelId"
      :starred-ids="starredModelIds"
      :loading="modelsLoading"
      :unavailable="modelsUnavailable"
      @select="handleSelectModel($event)"
      @toggle-star="toggleStarModel($event)"
      @close="showModelPicker = false"
    />

    <ModelSwitchConfirmDialog
      v-if="modelSwitchConfirmPending !== null"
      :open="true"
      :hint="modelSwitchConfirmPending.hint"
      @select="modelSwitchConfirmStore().settle($event)"
    />

    <!-- Settings page (modal) -->
    <ErrorBoundary closable @close="showSettings = false">
    <SettingsDialog
      v-if="showSettings"
      :color-scheme="colorScheme"
      :font-scale="fontScale"
      :managed-provider-status="managedProviderStatus"
      :managed-user-info="managedUserInfo"
      :on-fetch-usage="getUsage"
      :notify="notifyEnabled"
      :notify-permission="notifyPermission"
      :notify-sound="notifySound"
      :config="config"
      :models="models"
      :config-saving="configSaving"
      :server-version="serverVersion"
      :initial-tab="browserSettingsRequested ? 'browser' : settingsShortcutAction ? 'shortcuts' : settingsInitialTab"
      :highlight-key="browserSettingsRequested || settingsShortcutAction ? undefined : settingsHighlightKey"
      :initial-browser-section="settingsBrowserSection"
      :initial-shortcut-action="settingsShortcutAction"
      @set-color-scheme="setColorSchemeFromSettings($event)"
      @set-font-scale="setFontScaleFromSettings($event)"
      @set-notify="setNotifyEnabled($event)"
      @set-notify-sound="setNotifySound($event)"
      @update-config="handleUpdateConfig($event)"
      @open-browser-url="openBrowserUrlFromSettings"
      @create-project="showSettings = false; settingsInitialTab = undefined; requestWorkspaceDialog($event)"
      @login="() => { showSettings = false; openLogin(); }"
      @logout="confirmLogout"
      @close="showSettings = false; settingsInitialTab = undefined; settingsBrowserSection = 'settings'"
    />
    </ErrorBoundary>

    <!-- Status panel overlay (/status) — renders current client state -->
    <StatusPanel
      v-if="showStatusPanel"
      :status="status"
      :session-id="client.activeSessionId.value"
      :thinking="statusPanelThinking"
      :model="statusPanelModel"
      :plan-mode="planMode"
      :swarm-mode="swarmMode"
      :tower-mode="client.towerMode.value"
      :tower-enabled="towerEnabled"
      :cost-usd="sessionCost"
      @close="showStatusPanel = false"
      @set-thinking="setThinking($event)"
    />

    <WorkspaceEditDialog
      v-if="workspaceDialog"
      :mode="workspaceDialog.mode"
      :initial-name="workspaceDialog.mode === 'edit' ? workspaceDialog.name : ''"
      :initial-dirs="workspaceDialog.dirs"
      :initial-host-id="workspaceDialog.hostId"
      :pick="pickMoreWorkspaceDirs"
      :pick-remote="pickRemoteWorkspaceDirs"
      :hosts="remoteHosts"
      :manage-hosts="() => openHostSettings(undefined, { addIfEmpty: true })"
      :import-project-config="importProjectConfigDirs"
      :busy="workspaceDialogBusy"
      @submit="onWorkspaceDialogSubmit"
      @cancel="closeWorkspaceDialog"
    />

    <AddWorkspaceDialog
      v-if="folderPickerRequest !== null"
      :multiple="folderPickerRequest.multiple"
      :browse-fs="(path, signal) => browseFs(path, signal, folderPickerRequest?.hostId)"
      :search-fs="(root, query, signal) => workspaces.searchFs(root, query, signal, folderPickerRequest?.hostId)"
      :get-fs-home="() => getFsHome(folderPickerRequest?.hostId)"
      :default-path="folderPickerRequest.defaultPath"
      :host-id="folderPickerRequest.hostId"
      :mkdir-fs="(path) => workspaces.mkdirFs(path, folderPickerRequest?.hostId)"
      @add="completeWorkspaceFolderPicker([$event])"
      @add-many="completeWorkspaceFolderPicker"
      @close="cancelWorkspaceFolderPicker"
    />

    <AddWorkspaceDialog
      v-if="showAddWorkspace"
      :browse-fs="(path, signal) => browseFs(path, signal)"
      :search-fs="(root, query, signal) => workspaces.searchFs(root, query, signal)"
      :get-fs-home="getFsHome"
      :mkdir-fs="mkdirFs"
      :default-path="visibleWorkspace?.root ?? status.cwd"
      :error="addWorkspaceError"
      @add="handleAddWorkspace($event)"
      @close="handleCloseAddWorkspace"
    />

    <!-- Global connecting splash on first load (until the daemon round-trips) -->
    <Transition name="gload-fade">
      <GlobalLoading
        v-if="!initialized"
        :issue="connectIssue"
        :stage="bootStage"
        :retries="bootRetries"
      />
    </Transition>

    <!-- Global modal-confirmation host (driven by useConfirmDialog) -->
    <BrowserOverlayConfirmHost :active="browserConfirmUsesNativeSurface" />
    <ConfirmDialogHost v-if="!browserConfirmUsesNativeSurface" />
    <PastedTextDialog />

    <!-- Mobile switcher bottom-sheet: workspace groups + sessions (mirrors the
         desktop sidebar) -->
    <MobileSwitcherSheet
      v-if="isMobile"
      v-model="showMobileSwitcher"
      :groups="mobileWorkspaceGroups"
      :flat-sessions="flatSessions"
      :pinned-sessions="pinnedSessions"
      :flat-has-more="flatSessionsHasMore"
      :flat-loading-more="flatSessionsLoadingMore"
      :active-workspace-id="activeWorkspaceId"
      :active-id="activeSessionId"
      :attention-by-session="attentionBySession"
      :attention-by-workspace="attentionByWorkspace"
      @select="handleSelectSession($event)"
      @create="runShortcutAction('newSession', 'button')"
      @create-in-workspace="handleCreateSessionInWorkspace($event)"
      @add-workspace="requestWorkspaceDialog()"
      @rename="(id, title) => renameSession(id, title)"
      @archive="void archiveSessionWithToast($event)"
      @delete="void deleteSessionWithToast($event)"
      @delete-workspace="confirmDeleteWorkspace($event)"
      @load-more="(id) => void loadMoreSessions(id)"
      @ensure-flat-sessions="void ensureFlatSessions()"
      @load-more-flat-sessions="void loadMoreFlatSessions()"
    />

    <!-- Mobile settings bottom-sheet: session controls + app prefs + auth -->
    <MobileSettingsSheet
      v-if="isMobile"
      v-model="showMobileSettings"
      :initial-tab="mobileSettingsInitialTab"
      :highlight-key="settingsHighlightKey"
      :status="status"
      :thinking="thinking"
      :models="activeModels"
      :plan-mode="planArmed || planMode"
      :goal-mode="goalMode"
      :goal-active="mobileGoalActive"
      :swarm-mode="swarmMode"
      :tower-mode="client.towerMode.value"
      :tower-enabled="towerEnabled"
      :color-scheme="colorScheme"
      :font-scale="fontScale"
      :managed-provider-status="managedProviderStatus"
      :managed-user-info="managedUserInfo"
      :server-version="serverVersion"
      @pick-model="openModelPicker()"
      @set-thinking="setThinking($event)"
      @toggle-plan="togglePlanMode()"
      @toggle-goal="toggleGoalMode()"
      @focus-goal="onMobileFocusGoal"
      @toggle-swarm="toggleSwarmMode()"
      @toggle-tower="onToggleTower"
      @set-permission="setPermission($event)"
      @set-color-scheme="setColorSchemeFromSettings($event, 'mobile_settings')"
      @set-font-scale="setFontScaleFromSettings($event, 'mobile_settings')"
      @login="() => { showMobileSettings = false; openLogin(); }"
      @logout="confirmLogout"
    />
    </div>
    <!-- First-run onboarding wizard (language → appearance → notifications →
         Kimi login). Held back until the first load settled so it can't cover
         the connecting splash. Outside `.app` like LoginDialog — `.app` goes
         inert while the wizard is up, and the wizard must stay focusable. -->
    <OnboardingWizard
      v-if="initialized && showOnboarding"
      :signed-in="signedIn"
      :on-start-o-auth-login="handleStartOAuthLogin"
      :on-poll-o-auth-login="handlePollOAuthLogin"
      :on-cancel-o-auth-login="handleCancelOAuthLogin"
      :on-get-o-auth-region="handleGetOAuthRegion"
      @complete="completeOnboarding"
      @login-success="handleWizardLoginSuccess"
      @add-provider="handleWizardAddProvider"
    />
    <!-- Login Dialog overlay. It is outside `.app` so `/login` can open it too. -->
    <ScreenshotGuidanceDialog />
    <GlobalFeedbackDialog :key="desktopFeedback.accountEpoch.value" :target="globalFeedbackTarget" @close="globalFeedbackTarget = null" />
    <LoginDialog
      v-if="showLogin || hostLoginId !== null"
      :key="hostLoginId ?? 'local'"
      :title="hostLoginTitle"
      :remote-host="hostLoginId !== null"
      :on-start-o-auth-login="hostLoginId !== null ? (region) => hostsStore().startLogin(region) : handleStartOAuthLogin"
      :on-poll-o-auth-login="hostLoginId !== null ? () => hostsStore().pollLogin() : handlePollOAuthLogin"
      :on-cancel-o-auth-login="hostLoginId !== null ? () => hostsStore().cancelLogin() : handleCancelOAuthLogin"
      :on-get-o-auth-region="hostLoginId !== null ? () => hostsStore().loginRegion() : handleGetOAuthRegion"
      @success="hostLoginId !== null ? finishHostLogin(hostLoginId) : handleLoginSuccess()"
      @close="hostLoginId !== null ? hostsStore().closeLogin() : (showLogin = false)"
    />
    <!-- Floating preview for tool-card media (image/video). The component
         teleports its own overlays, so mounting inside `.app` is safe. -->
    <MediaLightbox
      v-if="mediaLightbox"
      :media="mediaLightbox"
      :origin-img="mediaLightboxImg"
      :images="mediaLightboxImages"
      :index="mediaLightboxIndex"
      @close="
        mediaLightbox = null;
        mediaLightboxImg = null;
        mediaLightboxImages = undefined;
        mediaLightboxIndex = undefined;
      "
    />
    <FileContextMenuHost />
    <ForcedUpgradeDialog @update:visible="forcedUpgradeVisible = $event" />
  </div>
</template>

<style scoped>
.gload-fade-leave-active { transition: opacity 0.28s ease; }
.gload-fade-leave-to { opacity: 0; }

.app-shell {
  position: fixed;
  top: var(--app-top, 0px);
  left: 0;
  right: 0;
  height: 100vh;
  height: 100dvh;
  height: var(--app-height, 100dvh);
  display: flex;
  flex-direction: column;
  overflow: clip;
  box-sizing: border-box;
}
.app {
  flex: 1;
  min-height: 0;
  position: relative;
  display: grid;
  grid-template-columns: auto 0 minmax(0, 1fr) auto;
  grid-template-rows: minmax(0, 1fr) auto;
  background: var(--bg);
  color: var(--color-text);
  overflow: clip;
  box-sizing: border-box;
}
.app.custom-titlebar > .right-panel-toggle {
  top: calc(var(--titlebar-height) + (var(--panel-head-h, 48px) - var(--icon-button-sm)) / 2);
}
.app.custom-titlebar {
  padding-top: var(--titlebar-height);
}
.app.panel-expanded {
  grid-template-columns: auto 0 0 minmax(0, 1fr);
}
.app.panel-expanded > .con,
.app.panel-expanded > .terminal-drop-zone,
.app.panel-expanded > .terminal-panel {
  display: none;
}
.app.macos-desktop.vibrancy {
  background: transparent;
}
.app > * {
  min-height: 0;
  min-width: 0;
}

.app > .side { grid-column: 1; grid-row: 1 / -1; }
.side-handle { grid-column: 2; grid-row: 1 / -1; }
.app:not(.mobile) > .con { grid-column: 3; grid-row: 1; }

.right-panel-live {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  display: flex;
  border-radius: var(--radius-full);
  box-shadow: 0 0 0 var(--browser-live-dot-halo) var(--color-bg);
  pointer-events: none;
}
.right-panel-toggle {
  position: absolute;
  top: var(--panel-head-inset);
  right: var(--panel-head-inset);
  z-index: var(--z-sticky);
  -webkit-app-region: no-drag;
}
.app:not(.mobile) :deep(.ch-panel),
.app:not(.mobile) :deep(.ch-toggles:not(:has(.ch-terminal))),
.app:not(.mobile) :deep(.ptb-hide) {
  display: none;
}
.app:not(.mobile) :deep(.chat-header) {
  transition: padding-left 0.28s cubic-bezier(0.4, 0, 0.2, 1), padding-right var(--duration-slow) var(--ease-in-out);
}
.app:not(.mobile) :deep(.session-admin .sa-head) {
  transition: padding-right var(--duration-slow) var(--ease-in-out);
}
.app:not(.mobile):not(.right-panel-open) :deep(.chat-header),
.app:not(.mobile):not(.right-panel-open) :deep(.session-admin .sa-head) {
  padding-right: calc(var(--panel-head-inset) + var(--icon-button-sm) + var(--space-2));
}
.app:not(.mobile) :deep(.panel-tab-bar) {
  padding-right: calc(var(--panel-head-inset) + var(--icon-button-sm) + var(--space-05));
}

.sidebar-toggle-btn {
  position: absolute;
  top: 11px;
  left: 16px;
  z-index: var(--z-sticky);
  animation: sidebar-toggle-btn-in 0.18s var(--ease-out) 0.12s backwards;
  -webkit-app-region: no-drag;
}
.app.macos-desktop .sidebar-toggle-btn {
  left: 84px;
  animation: none;
}
.app.macos-desktop.fullscreen .sidebar-toggle-btn {
  left: 16px;
}
.new-chat-btn {
  position: absolute;
  top: 11px;
  left: 42px;
  z-index: var(--z-sticky);
  animation: sidebar-toggle-btn-in 0.18s var(--ease-out) 0.12s backwards;
  -webkit-app-region: no-drag;
}
.app.macos-desktop .new-chat-btn {
  left: 110px;
}
.app.macos-desktop.fullscreen .new-chat-btn {
  left: 42px;
}
@keyframes sidebar-toggle-btn-in {
  from { opacity: 0; }
}

.app.mobile {
  grid-template-columns: 1fr;
  grid-template-rows: auto 1fr;
}

.terminal-panel {
  --terminal-h: 260px;
  grid-column: 3;
  grid-row: 2;
  min-height: 0;
  height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border-top: var(--p-hairline) solid transparent;
  overflow: hidden;
  transition: height var(--duration-slow) var(--ease-in-out);
}
.terminal-panel.open {
  height: var(--terminal-h);
  border-top-color: var(--color-line);
}
.terminal-panel.no-anim {
  transition: none;
}
.terminal-panel > .tp {
  flex: 1;
  min-height: 0;
}
.app.mobile .terminal-panel {
  display: none;
}
</style>

<style>
:root {
  --panel-head-h: 48px;
  --panel-head-inset: calc((var(--panel-head-h) - var(--icon-button-sm)) / 2);
}

.app.sidebar-collapsed .session-admin .sa-head {
  padding-left: var(--header-collapsed-clearance);
}
.app.sidebar-collapsed.custom-titlebar .session-admin .sa-head {
  padding-left: var(--space-6);
}
.app.sidebar-collapsed.macos-desktop .session-admin .sa-head {
  padding-left: var(--header-collapsed-clearance-macos);
}
.app.fullscreen.sidebar-collapsed.macos-desktop .session-admin .sa-head {
  padding-left: var(--header-collapsed-clearance);
}
.app.panel-expanded.sidebar-collapsed .panel-tab-bar {
  padding-left: var(--header-collapsed-clearance);
}
.app.panel-expanded.sidebar-collapsed.custom-titlebar .panel-tab-bar {
  padding-left: var(--space-2);
}
.app.panel-expanded.sidebar-collapsed.macos-desktop .panel-tab-bar {
  padding-left: var(--header-collapsed-clearance-macos);
}
.app.fullscreen.panel-expanded.sidebar-collapsed.macos-desktop .panel-tab-bar {
  padding-left: var(--header-collapsed-clearance);
}

.app.macos-desktop .global-preview .ui-panel-header {
  -webkit-app-region: drag;
}
.app.macos-desktop .global-preview .ui-panel-header button,
.app.macos-desktop .global-preview .ui-panel-header input {
  -webkit-app-region: no-drag;
}
.app.macos-desktop .global-preview .panel-tab-bar {
  -webkit-app-region: drag;
}
.app.macos-desktop .global-preview .panel-tab-bar button {
  -webkit-app-region: no-drag;
}
.app.macos-desktop .global-preview .panel-tab-bar .ptb-tabs {
  -webkit-app-region: no-drag;
}
.app.macos-desktop .global-preview .panel-tab-bar .ptb-drag-fill {
  -webkit-app-region: drag;
}

.app.macos-desktop:has(.ch-menu, .open-in-menu, .dock-work-panel, .copy-menu-open, .panel-add-menu) .chat-header,
.app.macos-desktop:has(.ch-menu, .open-in-menu, .dock-work-panel, .copy-menu-open, .panel-add-menu) .side .ch,
.app.macos-desktop:has(.ch-menu, .open-in-menu, .dock-work-panel, .copy-menu-open, .panel-add-menu) .global-preview .ui-panel-header,
.app.macos-desktop:has(.ch-menu, .open-in-menu, .dock-work-panel, .copy-menu-open, .panel-add-menu) .global-preview .panel-tab-bar,
.app.macos-desktop:has(.ch-menu, .open-in-menu, .dock-work-panel, .copy-menu-open, .panel-add-menu) .global-preview .panel-tab-bar .ptb-drag-fill {
  -webkit-app-region: no-drag;
}
</style>
