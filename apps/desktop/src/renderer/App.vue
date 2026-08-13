<!-- apps/web/src/App.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Sidebar from './components/Sidebar.vue';
import ResizeHandle from './components/ResizeHandle.vue';
import ConversationPane from './components/chat/ConversationPane.vue';
import FilePreview from './components/FilePreview.vue';
import ThinkingPanel from './components/chat/ThinkingPanel.vue';
import AgentDetailPanel from './components/chat/AgentDetailPanel.vue';
import SideChatPanel from './components/chat/SideChatPanel.vue';
import DiffView from './components/chat/DiffView.vue';
import TurnDiffPanel from './components/chat/TurnDiffPanel.vue';
import MediaLightbox from './components/chat/MediaLightbox.vue';
import ModelPicker from './components/settings/ModelPicker.vue';
import LoginDialog from './components/dialogs/LoginDialog.vue';
import SettingsDialog from './components/settings/SettingsDialog.vue';
import AddWorkspaceDialog from './components/dialogs/AddWorkspaceDialog.vue';
import ConfirmDialogHost from './components/dialogs/ConfirmDialogHost.vue';
import StatusPanel from './components/chat/StatusPanel.vue';
import WarningToasts from './components/WarningToasts.vue';
import MobileTopBar from './components/mobile/MobileTopBar.vue';
import MobileSwitcherSheet from './components/mobile/MobileSwitcherSheet.vue';
import MobileSettingsSheet from './components/mobile/MobileSettingsSheet.vue';
import OnboardingWizard from './components/onboarding/OnboardingWizard.vue';
import GlobalLoading from './components/GlobalLoading.vue';
import DebugPanel from './debug/DebugPanel.vue';
import { isTraceEnabled } from './debug/trace';
import { useKimiWebClient } from './composables/useKimiWebClient';
import { getKimiWebApi } from './api';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import type { ColorScheme, FontScale, PromptAttachment } from './composables/useKimiWebClient';
import type { OpenMediaRequest, ToolMedia, TurnAttachment } from './types';
import { usePageTitle } from '@moonshot-ai/app-client/composables';
import { useSidebarLayout } from '@moonshot-ai/app-client/composables';
import { useFilePreview, type DetailTarget } from '@moonshot-ai/app-client/composables';
import { useDetailPanel } from '@moonshot-ai/app-client/composables';
import { useIsMobile } from '@moonshot-ai/app-client/composables';
import { openDialogCount } from '@moonshot-ai/app-ui';
import type { SwarmMember } from '@moonshot-ai/app-core/client';
import ServerAuthDialog from './components/ServerAuthDialog.vue';
import { initServerAuth, onAuthRequired } from '@moonshot-ai/app-core/lib';
import {
  canPickWorkspaceDirectory,
  createAddWorkspaceEntry,
  pickWorkspaceDirectory,
} from './lib/nativeWorkspacePicker';
import type { AppConfig, ThinkingLevel } from './api/types';
import { commitLevel, effectiveThinkingLevel, segmentsFor } from '@moonshot-ai/app-core/lib';
import { modelDisplayName, subagentEffortSuffix } from '@moonshot-ai/app-core/lib';
import { stripSkillPrefix } from '@moonshot-ai/app-core/lib';
import { ActionToast, Icon, IconButton } from '@moonshot-ai/app-ui';
import { isDesktop, isMacosDesktop, isWindowsDesktop } from '@moonshot-ai/app-core/lib';
import WindowsTitleBar from './components/window/WindowsTitleBar.vue';
import TerminalPanel from './components/terminal/TerminalPanel.vue';
import TerminalResizeHandle from './components/terminal/TerminalResizeHandle.vue';
import { selectContentsOf } from '@moonshot-ai/app-core/lib';
import { useFullscreen } from './composables/useFullscreen';
import { useNativeTerminal, nativeTerminalDraftKey } from './composables/useNativeTerminal';
import { runWhenInitialized, useTrayAttention } from './composables/useTrayAttention';
import { useJumpList } from './composables/useJumpList';
import { useVibrancy } from './composables/useVibrancy';
import { matchShortcutAction, terminalPassesChordToPty } from './composables/useShortcuts';
import { shortcutActionById } from './lib/keymap';
import {
  canOpenInNative,
  listNativeOpenInApps,
  openInNativeApp,
  resolveOpenInTarget,
  useDefaultOpenInTarget,
} from './lib/nativeOpenIn';
import { track } from './lib/track';
import { openUpgrade } from '@moonshot-ai/app-core/lib';
import { setSessionIntent } from './lib/session-intent';
import type { SessionCreatedSource } from '../shared/track-events';
import { isAppActionId, type AppActionId } from '../shared/action-ids';

// Hydrate the server-transport credential (fragment token or localStorage)
// BEFORE the client connects, so the first REST/WS calls already carry it.
initServerAuth();
// Stays false until the server actually rejects us with 401/40101. Starting
// from "no credential ⇒ prompt" flashed the token dialog for a frame in
// `--dangerous-bypass-auth` mode, before /meta had advertised the bypass.
const authRequired = ref(false);
let offAuthRequired: (() => void) | null = null;

const client = useKimiWebClient();
// When the server runs with `--dangerous-bypass-auth`, `/meta` advertises it
// and we skip the token prompt entirely — there is no credential to enter.
const showServerAuth = computed(
  () => !client.dangerousBypassAuth.value && authRequired.value,
);
provide('resolveImage', client.resolveImageUrl);
// Live swarm member roster for the inline AgentSwarm tool card. Sourced from the
// AppTask store so the card shows each subagent's live phase; on refresh the
// tasks are gone and the card falls back to the parsed tool result. Includes
// single-member "swarms" (e.g. AgentSwarm with one resume_agent_ids entry),
// which buildSwarmGroups filters out for the badge counter.
provide(
  'resolveSwarmMembers',
  (toolCallId: string): SwarmMember[] => client.swarmMembersByToolCallId.value.get(toolCallId) ?? [],
);
// Alias → friendly model name, shared by every subagent surface (Agent tool
// card meta, dock task rows, detail panel subtitle, swarm overview).
provide('modelDisplay', (alias: string | undefined): string | undefined =>
  modelDisplayName(alias, client.models.value),
);
const { t } = useI18n();
// A subagent's thinking effort segment: concrete levels are always shown;
// the boolean states ('on'/'off') carry no level and stay hidden.
provide('subagentEffort', (effort: string | undefined): string | undefined =>
  subagentEffortSuffix(effort),
);
const { confirm } = useConfirmDialog();

// KAP/daemon debug panel — opt-in via ?debug=1 or localStorage kimi-web.debug=1.
const debugEnabled = isTraceEnabled();

// Narrow viewports (≤640px) render the single-column mobile shell; desktop is
// unchanged. Falls back to desktop when matchMedia is unavailable.
const isMobile = useIsMobile();

// Native-window fullscreen state (desktop bridge only; always false on web).
// On macOS fullscreen the traffic lights hide, so the resident sidebar toggle
// drops their slot and hugs the left edge (see the fullscreen CSS below).
const isFullscreen = useFullscreen();

// Frosted-sidebar (vibrancy) preference — paints the root chain / .app /
// sidebar transparent only while on; layout keeps keying off macos-desktop.
const { vibrancy } = useVibrancy();

// Native embedded terminal (desktop-only; inert no-op on web): per-session
// buckets in a module singleton shared with the ⌃` dispatcher and the View
// menu action (design: docs/plans/2026-07-27-desktop-native-terminal.md).
const terminalStore = useNativeTerminal();
const terminalOpen = terminalStore.open;
// Mount the panel lazily on first open, then keep it mounted — an unmounted
// xterm loses its scrollback.
const terminalEverOpened = ref(terminalOpen.value);
watch(terminalOpen, (isOpen) => {
  if (isOpen) terminalEverOpened.value = true;
});
// New tabs spawn in the visible workspace (daemon cwd as fallback).
const terminalCwd = computed(
  () => client.visibleWorkspace.value?.root ?? client.status.value.cwd ?? null,
);
// The draft's first action creates a session IN PLACE: it inherits the draft
// bucket's terminals. Migration anchors to the id RETURNED by the creation call.
function terminalBucketKey(sessionId: string, workspaceId: string | null): string {
  return sessionId === '' ? nativeTerminalDraftKey(workspaceId) : sessionId;
}

function migrateDraftTerminals(fromKey: string, createdId: string | null): void {
  if (createdId !== null) {
    terminalStore.migrateDraftTo(fromKey, createdId);
  }
}

// `/goal`, `/btw` and the side-chat toggle create the first session INSIDE
// the client — they need the same draft-bucket migration.
async function runSessionCreatingAction(run: () => Promise<string | null>): Promise<void> {
  const workspaceId = client.activeWorkspaceId.value;
  if (client.activeSessionId.value || !workspaceId) {
    void run();
    return;
  }
  const draftKey = terminalBucketKey('', workspaceId);
  migrateDraftTerminals(draftKey, await run());
}

// The composer goal UI emits createGoal directly — route it through the same
// draft-bucket migration as the `/goal <objective>` slash path.
function handleCreateGoal(objective: string): void {
  void runSessionCreatingAction(() => client.createGoal(objective));
}

// Follow the visible session (and the draft's workspace): each session owns
// its terminal bucket. Snap the panel height on switches (no-anim).
const terminalSwitching = ref(false);
watch(
  () => [client.activeSessionId.value, client.activeWorkspaceId.value] as const,
  ([sessionId, workspaceId]) => {
    terminalStore.switchSession(terminalBucketKey(sessionId, workspaceId));
    terminalSwitching.value = true;
    void nextTick(() => {
      terminalSwitching.value = false;
    });
  },
  { immediate: true },
);

// Push the global pending-attention totals (unread sessions + awaiting
// approvals + awaiting questions) to the native tray: macOS menu-bar count +
// tray tooltip/menu breakdown. No-op without the desktop bridge (web).
useTrayAttention(client);

// Push the recent workspaces to the Windows Jump List (taskbar right-click),
// and route launch actions (Jump List clicks, second-instance argv) back
// into the app. No-op without the desktop bridge (web).
useJumpList(client, (payload) => {
  runWhenInitialized(client.initialized, () => {
    if (payload.action === 'new-chat') {
      setSessionIntent('jump_list');
      handleCreateSession();
    } else {
      void openWorkspaceByRoot(payload.root);
    }
  });
});

// Mobile sheet visibility
const showMobileSwitcher = ref(false);
const showMobileSettings = ref(false);

// Active session title for the mobile top bar.
const activeSessionTitle = computed<string>(() => {
  const id = client.activeSessionId.value;
  return client.sessions.value.find((s) => s.id === id)?.title ?? '';
});

// End reason of the active session's latest turn — ConversationPane marks the
// transcript when it was manually stopped.
const activeLastTurnReason = computed(() => {
  const id = client.activeSessionId.value;
  return client.sessions.value.find((s) => s.id === id)?.lastTurnReason ?? null;
});

// Number of sessions in the active workspace (mobile top-bar sub-line).
const activeWorkspaceSessionCount = computed<number>(
  () => client.visibleWorkspace.value?.sessionCount ?? 0,
);

// running: true when activity is not idle
const running = computed(() => client.activity.value !== 'idle');

// Static page title (app name only). The session title and workspace name are
// intentionally excluded so the tab title stays stable. Prefixes an animated
// spinner while the agent is running so activity is visible at a glance.
usePageTitle({ running });

// The /thinking slash command has no popover anchor, so it steps to the next
// segment for the active model (effort models cycle through their declared
// levels; boolean models flip on/off; unsupported stays off).
function nextThinkingLevel(current: ThinkingLevel | undefined): ThinkingLevel {
  // Identity is the model id — display/model names can collide across providers.
  const model = client.models.value.find((m) => m.id === client.status.value.modelId);
  const segs = segmentsFor(model);
  // No stored preference means the model default is in effect — cycle from
  // there; a level the model doesn't declare (indexOf → -1) starts the cycle
  // at the first segment.
  const idx = segs.indexOf(effectiveThinkingLevel(model, current));
  const next = segs[(idx + 1) % segs.length] ?? segs[0] ?? 'off';
  return commitLevel(model, next);
}

// Status panel (/status) renders current client state only — show the
// effective thinking level so "no preference" reads as the model default that
// will actually run, not a blank.
const statusPanelThinking = computed<ThinkingLevel>(() => {
  const model = client.models.value.find((m) => m.id === client.status.value.modelId);
  return effectiveThinkingLevel(model, client.thinking.value);
});

// First-run onboarding wizard (language → appearance → notifications → Kimi
// login). Shown until the user finishes it once — completing OR skipping the
// login step both count.
const showOnboarding = ref(!client.onboarded.value);
function completeOnboarding(): void {
  client.setOnboarded(true);
  showOnboarding.value = false;
}

// iOS Safari does not shrink `dvh` for the on-screen keyboard. Instead it pans
// the visual viewport (offsetTop > 0) to reveal the focused field, which a
// 100dvh in-flow shell cannot follow: the dock ends up behind the keyboard, or
// the page shows a blank band past the shell's bottom edge. Pin the shell to
// the VISUAL viewport instead: position:fixed + top/height mirrored from
// visualViewport (height shrinks with the keyboard, offsetTop tracks the pan).
// No-ops on desktop, where offsetTop is 0 and height equals innerHeight.
let appHeightRaf = 0;
function setAppHeight(): void {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty('--app-height', `${vv?.height ?? window.innerHeight}px`);
  root.setProperty('--app-top', `${vv?.offsetTop ?? 0}px`);
}
function syncAppHeight(): void {
  if (appHeightRaf) return;
  appHeightRaf = requestAnimationFrame(() => {
    appHeightRaf = 0;
    setAppHeight();
  });
}

onMounted(() => {
  // Register the 401 listener before the first requests go out, so a token
  // rejection during the initial load() can never be missed.
  offAuthRequired = onAuthRequired(() => {
    authRequired.value = true;
    // The server now demands a token, so any cached "bypass" state from a
    // previous mode is stale — drop it so the token prompt can show.
    client.clearDangerousBypassAuth();
  });
  void client.load();
  loadSidebarCollapsed();
  setAppHeight();
  window.visualViewport?.addEventListener('resize', syncAppHeight);
  window.visualViewport?.addEventListener('scroll', syncAppHeight);
  window.addEventListener('resize', syncAppHeight);
  window.addEventListener('resize', onTerminalWindowResize);
  // Capture-phase so Escape closes the side detail layer BEFORE the
  // conversation pane's bubble-phase handler interrupts a running prompt.
  document.addEventListener('keydown', onGlobalKeydown, true);
  // Bubble-phase global shortcut dispatcher (desktop-only customizable keys;
  // see lib/keymap.ts). Components get first claim via preventDefault.
  window.addEventListener('keydown', onShortcutKeydown);
  // Native app menu commands forward here over the preload bridge
  // (main/menu.ts → kimi:menu-action): Settings / New Chat / Open Folder map
  // onto the same shortcut actions as the renderer keymap, so a menu click and
  // the (menu-shadowed) key always do the same thing.
  offMenuAction =
    (window as { kimiDesktop?: { onMenuAction?: (cb: (id: string) => void) => () => void } })
      .kimiDesktop?.onMenuAction?.((menuId) => {
      // The edit menu's Select All forwards here (its accelerator shadows the
      // keydown, so the conversation pane never sees the chord on desktop).
      if (menuId === 'select-all') {
        track('action_invoked', { action: 'select-all', source: 'menu' });
        selectAllFromMenu();
        return;
      }
      // The connection retry itself runs main-side (menu.ts); the renderer
      // only records the menu-only action.
      if (menuId === 'retry-connection') {
        track('action_invoked', { action: 'retry-connection', source: 'menu' });
        return;
      }
      const actionId = MENU_ACTION_TO_SHORTCUT[menuId];
      if (actionId === undefined) return;
      // Menu clicks bypass the keydown dispatcher, so apply the same overlay
      // ownership here: opening the settings dialog on top of another modal
      // would stack competing focus traps — only the closing press (settings
      // already open) is allowed through.
      if (
        anyOverlayOpen.value &&
        !(actionId === 'openSettings' && (showSettings.value || showMobileSettings.value))
      ) {
        return;
      }
      runShortcutAction(actionId, 'menu');
    }) ?? null;
});

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown, true);
  window.removeEventListener('keydown', onShortcutKeydown);
  if (offMenuAction !== null) {
    offMenuAction();
    offMenuAction = null;
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

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // Inside the terminal, Esc is program input (vim/less/fzf) — never let the
  // global panel-close path consume it.
  if (e.target instanceof HTMLElement && e.target.closest('.terminal-host') !== null) return;
  // A modal dialog open on top of the side panel owns Escape — leave the event
  // alone so the dialog can close itself instead of the panel behind it.
  if (anyOverlayOpen.value) return;
  // Another capture listener on this same element may already have consumed
  // the key (e.g. the dock work panel) — one Escape closes one layer.
  if (e.defaultPrevented) return;
  if (closeOpenSidePanel()) {
    // Immediate: ChatDock's work-panel handler hangs off the SAME element —
    // stopPropagation alone would still let it run and close both layers.
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}

// ---------------------------------------------------------------------------
// Customizable keyboard shortcuts (desktop-only — web keeps its hardcoded
// keys, see docs/native-todos.md). Global-scope actions dispatch through this
// one window listener; the composer/conversation scopes stay in their own
// components, which read the same registry via useShortcuts.
// ---------------------------------------------------------------------------
let offMenuAction: (() => void) | null = null;

// Native menu item id → shortcut action id (main/menu.ts); both entry points
// run the same handler.
const MENU_ACTION_TO_SHORTCUT: Record<string, AppActionId> = {
  'open-settings': 'openSettings',
  'new-chat': 'newSession',
  'open-folder': 'openFolder',
  'toggle-terminal': 'toggleTerminal',
};

const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null);

// "Open in <default app>": same target resolution as the header menu pick
// (nativeOpenIn.ts owns the persisted default), keyed off the same root the
// ChatHeader gets.
async function openWorkspaceInDefaultApp(): Promise<void> {
  const root = client.visibleWorkspace.value?.root ?? client.status.value.cwd;
  if (!root || !canOpenInNative()) return;
  const apps = await listNativeOpenInApps();
  const target = resolveOpenInTarget(
    apps.map((app) => app.id),
    useDefaultOpenInTarget().value,
  );
  if (target === null) return;
  await openInNativeApp(target, root);
}

// Single funnel for app-level actions — the keydown dispatcher, the native
// menu, and the UI buttons all dispatch through here, so action_invoked
// source attribution lives in exactly one place.
const SESSION_INTENT_BY_ACTION_SOURCE: Record<'shortcut' | 'menu' | 'button', SessionCreatedSource> = {
  shortcut: 'shortcut',
  menu: 'menu',
  // The buttons all live in the sidebar (or its mobile/floating variants).
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
    case 'searchSessions':
      sidebarRef.value?.toggleSearch();
      break;
    case 'newSession':
      setSessionIntent(SESSION_INTENT_BY_ACTION_SOURCE[source]);
      handleCreateSession();
      break;
    case 'archiveSession': {
      // Same no-confirm + undo-toast path as the sidebar archive button.
      const sid = client.activeSessionId.value;
      if (sid) void archiveSessionWithToast(sid);
      break;
    }
    case 'toggleSideChat':
      // Same toggle as a bare `/btw` (see handleCommand).
      if (client.sideChatVisible.value) {
        closeSideChat();
      } else {
        void runSessionCreatingAction(() => openSideChatTab());
      }
      break;
    case 'openFolder':
      void requestAddWorkspace();
      break;
    case 'openInDefaultApp':
      void openWorkspaceInDefaultApp();
      break;
    case 'toggleTerminal':
      // The panel never renders in the mobile layout (only reachable at
      // extreme zoom on desktop) — toggling there would spawn an invisible
      // PTY and persist a misleading open state. No bridge (web / old shell)
      // gets the same no-op as the button entries.
      if (!isMobile.value && terminalStore.available) {
        terminalStore.toggle(terminalCwd.value ?? undefined);
      }
      break;
  }
}

// The native Select All menu item forwards here (click or shadowed
// accelerator). Mirror the keydown path without a key event: editable focus
// keeps the field's own select-all, an open overlay keeps the document-wide
// default, otherwise the conversation region routing decides.
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

function onShortcutKeydown(e: KeyboardEvent): void {
  // A component (composer, dialog, recorder…) already claimed this key —
  // preventDefault is always set before the window bubble listener runs.
  if (e.defaultPrevented) return;
  if (e.isComposing || e.keyCode === 229) return;
  // Key-repeat must never re-fire an action: holding the archive combo would
  // otherwise archive chat after chat (no confirm), and toggles would flap.
  if (e.repeat) return;
  const id = matchShortcutAction(e, 'global');
  if (id === null || !isAppActionId(id)) return;
  // A chord the terminal captured (menu-suspension pass-through, see
  // useShortcuts) must not also fire its global action from the bubble.
  if (
    e.target instanceof HTMLElement &&
    e.target.closest('.terminal-host') !== null &&
    terminalPassesChordToPty(e, id)
  ) {
    return;
  }
  // Session-scoped actions (archive / side chat / open-in) only fire with an
  // active chat — never on the new-chat draft or onboarding pages.
  const action = shortcutActionById(id);
  if (action?.requiresSession === true && !client.activeSessionId.value) return;
  // Overlays own the keyboard while open — the only exceptions are presses
  // that CLOSE the dialog that's already open (settings/search toggles).
  // Opening another dialog on top of a modal would stack competing focus
  // traps and Escape handlers.
  if (anyOverlayOpen.value) {
    const closesOpenDialog =
      (id === 'openSettings' && (showSettings.value || showMobileSettings.value)) ||
      (id === 'searchSessions' && sidebarRef.value?.isSearchOpen() === true);
    if (!closesOpenDialog) return;
  }
  e.preventDefault();
  runShortcutAction(id, 'shortcut');
}

// ---------------------------------------------------------------------------
// Unified right-side detail layer. Only one detail is open at a time. The
// shared `detailTarget` ref lives here so the file-preview and detail-panel
// composables can both claim the single right-side slot.
// ---------------------------------------------------------------------------
const detailTarget = ref<DetailTarget | null>(null);

const {
  previewTarget,
  previewFile,
  previewLoading,
  previewError,
  previewDownloadUrl,
  previewExternalActions,
  openFilePreview,
  closeFilePreview,
  openPreviewInEditor,
  revealPreviewFile,
} = useFilePreview({
  client,
  detailTarget,
  t: (key, params) => (params === undefined ? t(key) : t(key, params)),
});

// True while the right-side slot is actually occupied, so the sidebar reserves
// room for it and the conversation can never be squeezed. Keyed off detailTarget
// (the real occupant) rather than previewTarget, which can stay set after the
// panel is hidden.
const previewOpen = computed(() => detailTarget.value !== null);

// Floating preview for tool-card media (ReadMediaFile image/video): the same
// MediaLightbox user-bubble attachments get — PhotoSwipe for images (zooming
// out of the clicked thumbnail), the custom modal player for videos.
const mediaLightbox = ref<ToolMedia | null>(null);
/** The clicked thumbnail <img> — the image preview's zoom origin (PhotoSwipe). */
const mediaLightboxImg = ref<HTMLImageElement | null>(null);

function onOpenMedia(payload: OpenMediaRequest): void {
  mediaLightboxImg.value = payload.originImg ?? null;
  mediaLightbox.value = payload.media;
}

// ---------------------------------------------------------------------------
// Layout: resizable session column. ResizeHandle owns the column width (with
// localStorage persistence); we mirror it here to drive the App grid.
// ---------------------------------------------------------------------------
const {
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  sidebarMax,
  sessionColWidth,
  sidebarCollapsed,
  sidebarDragging,
  sideWidth,
  loadSidebarCollapsed,
  toggleSidebarCollapse,
} = useSidebarLayout({ previewOpen });

// ---------------------------------------------------------------------------
// Unified right-side detail layer (compaction / agent / diff / side
// chat) plus the preview-panel width. Only one detail is open at a time.
// ---------------------------------------------------------------------------
const {
  PREVIEW_WIDTH_KEY,
  PREVIEW_MIN,
  previewDefaultWidth,
  previewMax,
  previewWidth,
  previewPanelWidth,
  compactionPanelText,
  compactionPanelVisible,
  openCompactionPanel,
  closeCompactionPanel,
  agentPanelMember,
  agentPanelTurns,
  agentPanelLoading,
  agentPanelLoadError,
  agentPanelLoadingMore,
  agentPanelLoadMoreError,
  agentPanelHasMore,
  agentPanelRunning,
  openAgentPanel,
  closeAgentPanel,
  loadOlderAgentMessages,
  detailDiffMode,
  detailDiffPath,
  openDiffDetail,
  closeDiffDetail,
  selectDiffFile,
  turnDiffChange,
  openTurnDiff,
  closeTurnDiff,
  btwVisible,
  openSideChatTab,
  closeSideChat,
  sidePanelVisible,
  panelDragging,
  closeOpenSidePanel,
} = useDetailPanel({ client, sideWidth, detailTarget, closeFilePreview });

// Right-panel resize: --preview-w is owned IMPERATIVELY, never via a :style
// binding. Vue rewrites every bound style key on each patch (runtime-dom's
// patchStyle has no unchanged-value skip), so a bound --preview-w would let
// any unrelated mid-drag re-render clobber the live width with the stale
// pre-drag value. The watch applies the committed width on mount / panel
// remount / non-drag changes; during a drag the handle's applyLive writes
// each frame's width straight to the aside, and previewWidth commits once on
// pointerup (which this watch then re-applies).
const previewPanelEl = ref<HTMLElement | null>(null);
function applyPreviewWidthLive(width: number): void {
  previewPanelEl.value?.style.setProperty('--preview-w', `${width}px`);
}
watch(
  [previewPanelEl, previewPanelWidth],
  ([el, w]) => el?.style.setProperty('--preview-w', `${w}px`),
  { immediate: true },
);

// Terminal panel height: --terminal-h is owned imperatively for the same
// reason as --preview-w above (a bound style would clobber the live drag).
const TERMINAL_HEIGHT_KEY = 'kimi-web.terminal-panel-height';
const TERMINAL_DEFAULT_HEIGHT = 260;
const TERMINAL_MIN = 120;
// Reactive viewport height so the 60% cap tracks window resizes in both
// directions (a one-time innerHeight read would go stale).
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

// Reference to ConversationPane so we can imperatively switch tabs
const conversationPaneRef = ref<InstanceType<typeof ConversationPane> | null>(null);

// Dialog visibility refs
const showModelPicker = ref(false);

const showLogin = ref(false);
const showAddWorkspace = ref(false);
const showStatusPanel = ref(false);
const showSettings = ref(false);
// Deep link into a settings tab (the onboarding custom-provider entry opens
// Settings → Providers; the archive undo toast opens Settings → Archived).
// Read once at SettingsDialog mount, then reset on close so later manual
// opens land on General again.
const settingsInitialTab = ref<'providers' | 'archived' | undefined>(undefined);
// Same deep link for the mobile settings sheet (its archived sub-view).
// Reset when the sheet closes so later manual opens land on the main view.
const mobileSettingsInitialView = ref<'archived' | undefined>(undefined);
watch(showMobileSettings, (open) => {
  if (!open) mobileSettingsInitialView.value = undefined;
});

type SubmitPayload = {
  text: string;
  attachments: PromptAttachment[];
};
const pendingWorkspaceSubmit = ref<SubmitPayload | null>(null);
// Inline error shown inside the add-workspace picker after the daemon rejects
// a path. Kept separate from the global toast so the feedback is visible above
// the picker's backdrop and persists until the user retries or closes.
const addWorkspaceError = ref<string | null>(null);

// Any of these modal/overlay layers, when open, owns Escape. The global
// capture-phase handler must NOT close a background side panel out from under an
// open dialog — otherwise Escape dismisses the panel behind the dialog and the
// dialog's own Escape handler never fires. New top-level dialogs go here too.
const anyOverlayOpen = computed<boolean>(
  () =>
    openDialogCount.value > 0 ||
    showModelPicker.value ||
    showLogin.value ||
    showAddWorkspace.value ||
    showStatusPanel.value ||
    showSettings.value ||
    showOnboarding.value ||
    showMobileSwitcher.value ||
    showMobileSettings.value,
);

// Loading state for model/provider fetches
const modelsLoading = ref(false);
const modelsUnavailable = ref(false);
const configSaving = ref(false);

async function openModelPicker(): Promise<void> {
  modelsLoading.value = true;
  modelsUnavailable.value = false;
  showModelPicker.value = true;
  try {
    // Full refresh first (every refreshable provider, not just OAuth), so the
    // list always reflects the live catalog — the WS model-catalog event that
    // used to keep the cache warm is no longer forwarded by the daemon.
    await client.refreshAllProviders();
  } catch {
    modelsUnavailable.value = true;
  } finally {
    modelsLoading.value = false;
  }
}

function openLogin(): void {
  showLogin.value = true;
}

// Sign-out always confirms through the shared modal (the sidebar user menu
// confirms on its own; the settings dialogs route their logout event here).
async function confirmLogout(): Promise<void> {
  await confirm({
    title: t('sidebar.logoutConfirmTitle'),
    message: t('sidebar.logoutConfirmMessage'),
    variant: 'danger',
    action: () => client.logout(),
  });
}

// The wizard's custom-provider card: first run completes via this detour
// (same as skipping the login step), landing directly on the Providers tab.
function handleWizardAddProvider(): void {
  completeOnboarding();
  settingsInitialTab.value = 'providers';
  showSettings.value = true;
}

async function handleSelectModel(modelId: string): Promise<void> {
  showModelPicker.value = false;
  // Same semantics as the composer dropdown rows: the overlay is just the
  // "more models" continuation of the same flow, so it must also bump the
  // global default (see handleComposerSelectModel).
  await handleComposerSelectModel(modelId);
}

async function handleComposerSelectModel(modelId: string): Promise<void> {
  // Primary action: switch the active session's model via POST /sessions/{id}/profile
  // (same as the model picker overlay). Awaited so the model pill reflects the
  // result and failures surface. In the onboarding draft this just stores the
  // pick for the first session.
  const switched = await client.setModel(modelId);

  // Side effect: also bump the daemon-wide default model via POST /config so
  // new sessions inherit the choice. Fire-and-forget — it must not block the UI
  // or mask the session switch. Only after a confirmed switch (a stale/invalid
  // alias must not become the global default), and skip when it already
  // matches the default.
  if (switched && modelId !== client.defaultModel.value) {
    void client.updateConfig({ defaultModel: modelId });
  }
}

// Archive runs WITHOUT a confirm dialog: archive immediately, then show a
// top-center toast with Undo / Settings links (design-system §03 ActionToast).
// Every archive entry point (sidebar row, chat header, mobile switcher,
// shortcut) funnels here. client.archiveSession toasts its own errors and
// never rejects, so a failed archive simply shows no undo toast.
//
// Archive and export share ONE ActionToast state: the component paints a
// single fixed top-center pill with no stacking offset, so two live toasts
// would overlap exactly and hide each other's buttons. The newest action
// replaces the current toast — and an in-flight export's delayed writes (the
// 400ms running toast, the completion swap) compare keys first, so they never
// overwrite a newer toast (its Undo/Settings must survive).
// `key` is bumped on every assignment so the toast remounts and its
// auto-dismiss timer restarts (it is read once in setup) — the export
// running→done swap relies on this to get the 4s done window instead of
// inheriting the 60s running one.
type AppActionToast =
  | { kind: 'archive'; id: string; key: number }
  | { kind: 'export'; state: 'running' | 'done'; key: number };
const actionToast = ref<AppActionToast | null>(null);
let actionToastKey = 0;

async function archiveSessionWithToast(id: string): Promise<void> {
  await client.archiveSession(id);
  // Only destroy terminals once the session is really gone (sessionsForView
  // excludes archived entries) — a failed archive keeps both.
  if (client.sessionsForView.value.some((s) => s.id === id)) return;
  terminalStore.destroySession(id);
  actionToast.value = { kind: 'archive', id, key: ++actionToastKey };
}

// Export feedback mirrors the archive pattern (design-system §03 ActionToast,
// top-center): one toast channel for every export entry point (sidebar row,
// chat header, command palette). A progress toast only appears when the export
// outlasts ~400ms — the common sub-second case shows exactly one success
// toast. client.exportSession toasts its own errors and resolves false on
// failure, so a failed export simply shows no success toast. On desktop the
// success toast is skipped entirely — the native save dialog is the
// confirmation (a cancelled one must not read as "exported"); the 'running'
// state still appears for slow exports.
let exportToastInFlight = false;

async function exportSessionWithToast(id?: string): Promise<void> {
  // A duplicate click while one export runs leaves its toast untouched.
  if (exportToastInFlight) return;
  exportToastInFlight = true;
  const key = ++actionToastKey;
  const slowTimer = setTimeout(() => {
    // Only take the slot while no NEWER toast (e.g. an archive that started
    // after this export) owns it — its Undo/Settings actions must survive.
    if (actionToast.value === null || actionToast.value.key <= key) {
      actionToast.value = { kind: 'export', state: 'running', key };
    }
  }, 400);
  try {
    const ok = await client.exportSession(id);
    if (ok && !isDesktop) {
      // Same newer-toast guard as the running write above. Fresh key: force
      // a remount so the done toast's 4s timer starts now (see the
      // AppActionToast comment). Desktop is excluded: the renderer only
      // triggers the download — the native save dialog (main/downloads.ts)
      // is the confirmation there, and a cancelled dialog must not read as
      // "exported".
      if (actionToast.value === null || actionToast.value.key <= key) {
        actionToast.value = { kind: 'export', state: 'done', key: ++actionToastKey };
      }
    } else if (actionToast.value?.kind === 'export' && actionToast.value.key === key) {
      // Clear only this export's own running toast — a concurrent archive
      // toast is untouched.
      actionToast.value = null;
    }
  } finally {
    clearTimeout(slowTimer);
    exportToastInFlight = false;
  }
}

// Undo puts the session back at the front of the sidebar list (no
// re-selection). On failure the toast stays so the user can retry — the
// error itself surfaces via WarningToasts.
async function undoArchive(): Promise<void> {
  const toast = actionToast.value;
  if (!toast || toast.kind !== 'archive') return;
  if (await client.restoreSession(toast.id)) {
    // A newer toast may have taken the slot while the restore was in flight
    // — clear only the one this Undo acted on.
    if (actionToast.value?.key === toast.key) actionToast.value = null;
  }
}

// A REPLACED ActionToast lives on for its leave transition, and its auto-
// dismiss timer only stops at unmount — so a stale instance can still emit
// dismiss. The component echoes back its dismissToken; only the live toast
// (matching key) may clear the shared state.
function dismissActionToast(token: string | number | undefined): void {
  if (token !== undefined && actionToast.value?.key === token) actionToast.value = null;
}

// "Settings" deep-links to the archived-sessions tab (desktop dialog) or
// sub-view (mobile sheet).
function openArchivedSettings(): void {
  actionToast.value = null;
  if (isMobile.value) {
    mobileSettingsInitialView.value = 'archived';
    showMobileSettings.value = true;
  } else {
    settingsInitialTab.value = 'archived';
    showSettings.value = true;
  }
}

async function confirmDeleteWorkspace(id: string): Promise<void> {
  const workspace = client.workspacesView.value.find((w) => w.id === id);
  const name = workspace?.name ?? id;
  // Legacy sessions may lack workspaceId — match the workspace root too.
  const root = workspace?.root;
  const sessionIds = client.sessions.value
    .filter((s) => s.workspaceId === id || (root !== undefined && s.cwd === root))
    .map((s) => s.id);
  const confirmed = await confirm({
    title: t('sidebar.removeWorkspace'),
    message: t('workspace.removeWorkspaceConfirm', { name }),
    variant: 'danger',
    action: async () => {
      await client.deleteWorkspace(id);
      track('workspace_removed', { workspace_count: client.workspacesView.value.length });
    },
  });
  if (!confirmed) return;
  if (client.workspacesView.value.some((w) => w.id === id)) return;
  for (const sessionId of sessionIds) {
    terminalStore.destroySession(sessionId);
  }
  // …and the no-session draft bucket keyed to this workspace.
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

// LoginDialog callbacks — delegates to composable
async function handleStartOAuthLogin() {
  return client.startOAuthLogin();
}

async function handlePollOAuthLogin() {
  return client.pollOAuthLogin();
}

async function handleCancelOAuthLogin() {
  return client.cancelOAuthLogin();
}

async function handleLoginSuccess(): Promise<void> {
  showLogin.value = false;
  // Re-check auth state and reload sessions now that we're authenticated
  await client.checkAuth();
  await client.load();
}

// The wizard's embedded login flow succeeded: mark onboarding done in the same
// stroke as the dialog path above (first-run completion requires nothing else).
async function handleWizardLoginSuccess(): Promise<void> {
  completeOnboarding();
  await client.checkAuth();
  await client.load();
}

// Edit + resend the last user message: undo the latest exchange on the daemon,
// then drop that message's text back into the composer for editing.
async function handleEditMessage(payload: {
  text: string;
  attachments?: TurnAttachment[];
}): Promise<void> {
  const result = await client.undo(1);
  // Failure already surfaced via pushOperationFailure — don't refill the
  // composer or claim success for a rewind that didn't happen.
  if (result === null) return;
  await nextTick();
  conversationPaneRef.value?.loadComposerForEdit(payload.text, payload.attachments);
  conversationPaneRef.value?.notifyUndone();
}

// Esc / Stop: abort the main turn and report the outcome back, so the pane's
// auto-retract fires only on a confirmed stop.
async function handleInterrupt(): Promise<void> {
  const aborted = await client.abortCurrentPrompt();
  conversationPaneRef.value?.onAbortOutcome(aborted);
}

// Handler for slash commands emitted by Composer (via ConversationPane)
//
// Rebuild composer-editable attachments for a gated/cancelled payload: the
// object URLs were revoked on submit, but the files were already uploaded, so
// the edit-loading path reuses the fileIds directly (authenticated thumbnails
// included) — the same mechanism as edit-and-resend for history messages.
function toEditableAttachments(atts: PromptAttachment[]): TurnAttachment[] {
  const api = getKimiWebApi();
  return atts.map((a) => ({
    kind: a.kind,
    url: api.getFileUrl(a.fileId),
    fileId: a.fileId,
    name: a.name,
  }));
}

// Sign-in gate, shared by every path that submits work (plain sends and
// command-form submissions like `/goal <objective>`). When the daemon reports
// no usable provider/model (GET /auth not ready), shows the sign-in prompt
// and hands the cleared composer content back — the gate must never eat the
// draft. Resolves true when the caller may proceed.
async function passAuthGate(text: string, attachments: PromptAttachment[]): Promise<boolean> {
  if (client.authReady.value) return true;
  // The cached flag can predate a readiness change that never re-ran
  // checkAuth through this client — a provider added in settings, a default
  // model bumped by a composer pick, another client signing in. Re-probe
  // before concluding sign-in is required.
  await client.checkAuth();
  if (client.authReady.value) return true;
  // The userinfo probe fired by checkAuth is fire-and-forget: a signed-in
  // account whose membership is still unknown gets an awaited probe first,
  // so a free account inside the probe window isn't sent back to login.
  const signedIn = client.managedProviderStatus.value === 'authenticated';
  if (signedIn && client.managedMembership.value === null) {
    await client.probeManagedMembership();
  }
  // A confirmed free managed account is already signed in — pointing it at
  // the login flow again makes no sense; the gate becomes the upgrade entry.
  const isFreeAccount = signedIn && client.managedMembership.value === 'free';
  const confirmed = await confirm(
    isFreeAccount
      ? {
          title: t('login.upgradeRequiredTitle'),
          message: t('login.upgradeRequiredMessage'),
          confirmLabel: t('sidebar.upgrade'),
          variant: 'primary',
        }
      : {
          title: t('login.requiredTitle'),
          message: t('login.requiredMessage'),
          confirmLabel: t('login.goToLogin'),
          variant: 'primary',
        },
  );
  conversationPaneRef.value?.loadComposerForEdit(text, toEditableAttachments(attachments));
  if (confirmed) {
    if (isFreeAccount) openUpgrade();
    else openLogin();
  }
  return false;
}

// Workspace gate for command-form submissions (`/goal <objective>`, `/swarm
// <task>`, skill activations): the same prompt as the plain-send gate, but
// the command goes back to the composer for a manual re-fire — its
// continuation is command-specific, not a plain prompt pendingWorkspaceSubmit
// can resume. Resolves true when the caller may proceed. Skill commands carry
// the composer's pending attachments — restore them alongside the text or a
// gated first-skill send would lose the chips.
async function passWorkspaceGateForCommand(text: string, attachments: PromptAttachment[] = []): Promise<boolean> {
  if (client.activeSessionId.value || client.activeWorkspaceId.value) return true;
  const pick = await confirm({
    title: t('workspace.requiredTitle'),
    message: t('workspace.requiredMessage'),
    confirmLabel: t('conversation.pickFolder'),
    variant: 'primary',
  });
  conversationPaneRef.value?.loadComposerForEdit(text, toEditableAttachments(attachments));
  if (pick) void requestAddWorkspace();
  return false;
}

// Both gates, for command paths that submit work. `text` is the full command
// line, handed back to the composer when gated; `attachments` are the
// composer's pending uploads (skill commands only — other commands pass none).
async function passCommandGates(text: string, attachments: PromptAttachment[] = []): Promise<boolean> {
  if (!(await passAuthGate(text, attachments))) return false;
  return passWorkspaceGateForCommand(text, attachments);
}

// Handler for slash commands emitted by Composer (via ConversationPane)
async function handleCommand(payload: { cmd: string; attachments: PromptAttachment[] }): Promise<void> {
  const { cmd, attachments } = payload;
  // `/compact <text>` carries an optional free-text instruction steering what
  // the summary should focus on (TUI parity).
  if (cmd === '/compact' || cmd.startsWith('/compact ')) {
    if (!(await passCommandGates(cmd))) return;
    client.compact(cmd.slice('/compact'.length).trim() || undefined);
    return;
  }
  // `/swarm` toggles swarm mode; `/swarm on|off` sets it; `/swarm <task>` enables
  // swarm and runs the task right away (TUI parity).
  if (cmd === '/swarm' || cmd.startsWith('/swarm ')) {
    const arg = cmd.slice('/swarm'.length).trim();
    if (arg === 'on') client.setSwarmMode(true);
    else if (arg === 'off') client.setSwarmMode(false);
    else if (arg) {
      if (!(await passCommandGates(cmd))) return;
      client.setSwarmMode(true);
      void client.sendPrompt(arg);
    }
    else void client.toggleSwarmMode();
    return;
  }
  // `/goal <objective>` creates a goal (and submits it); `/goal pause|resume|cancel`
  // controls the active one; bare `/goal` toggles goal mode for the next message.
  if (cmd === '/goal' || cmd.startsWith('/goal ')) {
    const arg = cmd.slice('/goal'.length).trim();
    if (arg === 'pause' || arg === 'resume' || arg === 'cancel') client.controlGoal(arg);
    else if (arg) {
      if (!(await passCommandGates(cmd))) return;
      void runSessionCreatingAction(() => client.createGoal(arg));
    }
    else client.toggleGoalMode();
    return;
  }
  // `/btw <question>` opens (creating if needed) the side chat and asks it; bare
  // `/btw` toggles the side-chat tab for the active session.
  if (cmd === '/btw' || cmd.startsWith('/btw ')) {
    const arg = cmd.slice('/btw'.length).trim();
    if (!arg && client.sideChatVisible.value) {
      // Use the detail-layer close so detailTarget is cleared too; the bare
      // client.closeSideChat() only hides the panel and leaves detailTarget set.
      closeSideChat();
    } else {
      if (arg && !(await passCommandGates(cmd))) return;
      void runSessionCreatingAction(() => openSideChatTab(arg || undefined));
    }
    return;
  }
  switch (cmd) {
    // `/new` and `/clear` are aliases: both open the onboarding composer. The
    // session is only created when the user sends the first message.
    case '/new':
    case '/clear':
      setSessionIntent('slash_command');
      handleCreateSession();
      break;
    case '/fork':
      void client.forkSession();
      break;
    case '/export':
      void exportSessionWithToast();
      break;
    case '/undo':
      void client.undo();
      break;
    case '/plan':
      client.togglePlanMode();
      break;
    case '/auto':
      client.setPermission('auto');
      break;
    case '/yolo':
      client.setPermission('yolo');
      break;
    case '/thinking':
      // No popover anchor from a slash command — step to the next level.
      client.setThinking(nextThinkingLevel(client.thinking.value));
      break;
    case '/status':
      showStatusPanel.value = true;
      break;
    case '/login':
      openLogin();
      break;
    default: {
      // Not a built-in command → treat it as a session skill activation
      // (the user picked `/skill:<skill>` from the menu, or typed
      // `/<skill> args`). Strip the `skill:` display prefix — the REST API
      // takes the bare skill name. The daemon answers an unknown name with
      // skill.not_found, surfaced as a warning, so a stray slash is harmless.
      // The composer's pending attachments ride along into the activation's
      // user message. With no active session, create one first (same path as
      // the first prompt) so the activation isn't silently dropped on the
      // new-session screen.
      const space = cmd.indexOf(' ');
      const name = stripSkillPrefix((space === -1 ? cmd : cmd.slice(0, space)).slice(1));
      const args = space === -1 ? undefined : cmd.slice(space + 1).trim() || undefined;
      if (!name) break;
      if (!(await passCommandGates(cmd, attachments))) return;
      if (!client.activeSessionId.value && client.activeWorkspaceId.value) {
        const draftKey = terminalBucketKey('', client.activeWorkspaceId.value);
        const createdId = await client.startSessionAndActivateSkill(
          client.activeWorkspaceId.value,
          name,
          args,
          attachments,
        );
        migrateDraftTerminals(draftKey, createdId);
      } else {
        void client.activateSkill(name, args, attachments);
      }
      break;
    }
  }
}

function handleUnqueue(index: number): void {
  client.unqueue(index);
}

// Editing a queued message: the Composer already loaded the text into its
// textarea; here we just remove it from the queue so it isn't sent twice.
function handleEditQueued(index: number): void {
  client.unqueue(index);
}

function handleReorderQueue(payload: { from: number; to: number }): void {
  client.reorderQueue(payload.from, payload.to);
}

async function handleSubmit(payload: SubmitPayload): Promise<void> {
  if (!(await passAuthGate(payload.text, payload.attachments))) return;
  const wsId = client.activeWorkspaceId.value;
  if (!client.activeSessionId.value && wsId) {
    const draftKey = terminalBucketKey('', wsId);
    const createdId = await client.startSessionAndSendPrompt(
      wsId,
      payload.text,
      payload.attachments,
    );
    migrateDraftTerminals(draftKey, createdId);
    return;
  }
  if (!client.activeSessionId.value && !wsId) {
    pendingWorkspaceSubmit.value = payload;
    // Ask first — never jump straight into the native folder picker.
    const pick = await confirm({
      title: t('workspace.requiredTitle'),
      message: t('workspace.requiredMessage'),
      confirmLabel: t('conversation.pickFolder'),
      variant: 'primary',
    });
    if (pick) {
      void requestAddWorkspace();
    } else {
      dropPendingWorkspaceSubmit();
    }
    return;
  }
  void client.sendPrompt(payload.text, payload.attachments);
}

// Drops a queued first-message submission and hands its content back to the
// composer, so cancelling the workspace gate/picker never eats the draft.
function dropPendingWorkspaceSubmit(): void {
  const pending = pendingWorkspaceSubmit.value;
  pendingWorkspaceSubmit.value = null;
  if (pending) {
    conversationPaneRef.value?.loadComposerForEdit(
      pending.text,
      toEditableAttachments(pending.attachments),
    );
  }
}

// Entry point for every "add workspace" affordance. On desktop the OS-native
// folder picker is the primary path; the daemon-driven in-app browser is the
// fallback for missing bridge, bridge errors, and daemon rejections. Only an
// explicit cancel drops a queued first message. Flow logic lives (tested) in
// lib/nativeWorkspacePicker.ts — App.vue is desktop-only from here on, so
// future web→desktop re-copies must keep this block (docs/native-todos.md).
const requestAddWorkspace = createAddWorkspaceEntry({
  canPick: canPickWorkspaceDirectory,
  pick: () => pickWorkspaceDirectory({ title: t('workspace.addTitle') }),
  add: addWorkspace,
  openFallbackDialog: () => {
    showAddWorkspace.value = true;
  },
  dropPending: () => {
    dropPendingWorkspaceSubmit();
  },
  reportError: () => {
    addWorkspaceError.value = t('workspace.addFailed');
  },
});

// Adds a workspace by path and, when a first message was queued while no
// workspace existed, continues it in the new workspace. Resolves false when
// the daemon rejects the path (caller surfaces the error).
async function addWorkspace(root: string): Promise<boolean> {
  addWorkspaceError.value = null;
  const added = await client.addWorkspaceByPath(root);
  if (!added) return false;
  track('workspace_added', { workspace_count: client.workspacesView.value.length });
  showAddWorkspace.value = false;
  // The no-workspace draft bucket's PTYs run in the fallback cwd, not the
  // just-added folder — discard them.
  terminalStore.destroySession(terminalBucketKey('', null));
  const pending = pendingWorkspaceSubmit.value;
  pendingWorkspaceSubmit.value = null;
  const wsId = client.activeWorkspaceId.value;
  if (pending && wsId) {
    await client.startSessionAndSendPrompt(wsId, pending.text, pending.attachments);
  }
  return true;
}

// @add handler of the in-app browser dialog. Keeps the dialog open (and the
// pending submission intact) on daemon rejection so the user can retry; the
// error shows inline. Closing via Escape goes through handleCloseAddWorkspace,
// which drops the pending prompt.
async function handleAddWorkspace(root: string): Promise<void> {
  const added = await addWorkspace(root);
  if (!added) {
    addWorkspaceError.value = t('workspace.addFailed');
    showAddWorkspace.value = true;
  }
}

function handleCloseAddWorkspace(): void {
  dropPendingWorkspaceSubmit();
  addWorkspaceError.value = null;
  showAddWorkspace.value = false;
}

// Sidebar folder drop (desktop-only: the sidebar gates the whole flow on the
// preload bridge, so this never fires on web). Adds each dropped folder via
// the same path as the native picker; a daemon rejection surfaces in the
// fallback dialog, like a picker failure. Part of the desktop-only
// add-workspace block — keep on web→desktop re-copies (docs/native-todos.md).
async function handleDropWorkspacePaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    // Sequential: each addWorkspace() also selects its workspace, so the last
    // successful drop ends up active — matching multi-pick order.
    const added = await addWorkspace(path);
    if (!added) {
      addWorkspaceError.value = t('workspace.addFailed');
      showAddWorkspace.value = true;
      break;
    }
    track('native_feature_used', { feature: 'workspace_drop' });
  }
}

// Launch-action "open this workspace" (Jump List item / second-instance
// argv): select it when already registered, otherwise add it through the
// standard flow (which also selects it). Part of the desktop-only
// add-workspace block — keep on web→desktop re-copies (docs/native-todos.md).
async function openWorkspaceByRoot(root: string): Promise<void> {
  const existing = client.workspacesView.value.find((workspace) => workspace.root === root);
  if (existing) {
    client.openWorkspace(existing.id);
    return;
  }
  const added = await addWorkspace(root);
  if (!added) {
    addWorkspaceError.value = t('workspace.addFailed');
    showAddWorkspace.value = true;
  }
}

function focusComposerAfterDraft(): void {
  void nextTick(() => {
    conversationPaneRef.value?.focusComposer();
  });
}

// The sidebar settings entry always OPENS the dialog (the modal blocks a
// second click), unlike the dispatcher's toggle for shortcut/menu presses.
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

// Primary "+ New": enter the draft state in the current workspace so the
// right pane shows the onboarding composer. The session is only created when
// the user sends the first message.
function handleCreateSession(): void {
  const wsId = client.activeWorkspaceId.value;
  if (wsId) {
    client.openWorkspaceDraft(wsId);
  } else {
    client.clearActiveSession();
  }
  focusComposerAfterDraft();
}

// Workspace-level "+ New" (sidebar group or mobile switcher): enter the draft
// state in the chosen workspace. No backend session is created until the user
// actually sends a message.
function handleCreateSessionInWorkspace(workspaceId: string): void {
  setSessionIntent('sidebar');
  client.openWorkspaceDraft(workspaceId);
  focusComposerAfterDraft();
}

// The draft composer's workspace picker only re-targets the pending draft —
// the entry intent (shortcut/menu/…) belongs to whoever opened the draft.
function handleDraftWorkspaceSelect(workspaceId: string): void {
  client.openWorkspaceDraft(workspaceId);
  focusComposerAfterDraft();
}

function handleSelectSession(selection: {
  sessionId: string;
  source: SessionCreatedSource;
}): void {
  void client.selectSession(selection.sessionId, { source: selection.source });
}

// Chat header: open a GitHub PR in a new tab.
function openPr(url: string): void {
  if (url) window.open(url, '_blank', 'noopener');
}
</script>

<template>
  <div class="app-shell">
    <ServerAuthDialog v-if="showServerAuth" />
    <!-- inert while the first-run wizard is up: the wizard lives outside
         `.app` and must own the whole tab order. -->
    <div
      class="app"
      :class="{
        mobile: isMobile,
        'sidebar-collapsed': sidebarCollapsed && !isMobile,
        'macos-desktop': isMacosDesktop,
        'windows-desktop': isWindowsDesktop,
        vibrancy: isMacosDesktop && vibrancy,
        fullscreen: isFullscreen,
      }"
      :inert="showOnboarding"
    >
    <WindowsTitleBar
      v-if="isWindowsDesktop && !isFullscreen"
      :sidebar-collapsed="sidebarCollapsed"
      @toggle-sidebar="runShortcutAction('toggleSidebar', 'button')"
    />
    <!-- Desktop navigation: workspace rail + resizable session column. -->
    <template v-if="!isMobile">
      <Sidebar
        ref="sidebarRef"
        :collapsed="sidebarCollapsed"
        :dragging="sidebarDragging"
        :col-width="sideWidth"
        :active-workspace="client.visibleWorkspace.value"
        :active-workspace-id="client.activeWorkspaceId.value"
        :sessions="client.sessionsForView.value"
        :groups="client.workspaceGroups.value"
        :workspace-sort-mode="client.workspaceSortMode.value"
        :pinned-sessions="client.pinnedSessions.value"
        :flat-sessions="client.flatSessions.value"
        :flat-has-more="client.flatSessionsHasMore.value"
        :flat-loading-more="client.flatSessionsLoadingMore.value"
        :initialized="client.initialized.value"
        :active-id="client.activeSessionId.value"
        :attention-by-session="client.attentionBySession.value"
        :pending-by-session="client.pendingBySession.value"
        :unread-by-session="client.unreadBySession.value"
        :backend="client.backend.value"
        @select="handleSelectSession($event)"
        @create="runShortcutAction('newSession', 'button')"
        @create-in-workspace="handleCreateSessionInWorkspace($event)"
        @select-workspace="client.openWorkspace($event)"
        @add-workspace="runShortcutAction('openFolder', 'button')"
        @add-workspace-paths="void handleDropWorkspacePaths($event)"
        @rename="(id, title) => client.renameSession(id, title)"
        @archive="archiveSessionWithToast($event)"
        @fork="(id) => client.forkSession(id)"
        @export="(id) => void exportSessionWithToast(id)"
        @pin="client.togglePinSession($event)"
        @unpin="client.unpinSession($event)"
        @drop-pin="client.pinSession($event)"
        @rename-workspace="(id, name) => client.renameWorkspace(id, name)"
        @delete-workspace="confirmDeleteWorkspace($event)"
        @reorder-workspaces="client.reorderWorkspaces($event)"
        @set-workspace-sort-mode="client.setWorkspaceSortMode($event)"
        @load-more-sessions="(id) => void client.loadMoreSessions(id)"
        @load-all-sessions="void client.loadAllSessions()"
        @ensure-flat-sessions="void client.ensureFlatSessions()"
        @load-more-flat-sessions="void client.loadMoreFlatSessions()"
        @open-settings="openSettingsFromButton"
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
      :workspace="client.visibleWorkspace.value"
      :session-title="activeSessionTitle"
      :running="running"
      :branch="client.status.value.branch"
      :session-count="activeWorkspaceSessionCount"
      @open-switcher="showMobileSwitcher = true"
      @open-settings="runShortcutAction('openSettings', 'button')"
    />

    <ConversationPane
      ref="conversationPaneRef"
      :mobile="isMobile"
      :turns="client.turns.value"
      :session-id="client.activeSessionId.value"
      :approvals="client.pendingApprovals.value"
      :changes="client.changes.value"
      :git-info="client.gitInfo.value"
      :tasks="client.tasks.value"
      :todos="client.todos.value"
      :goal="client.goal.value"
      :activation-badges="client.activationBadges.value"
      :status="client.status.value"
      :thinking="client.thinking.value"
      :plan-mode="client.planMode.value"
      :swarm-mode="client.swarmMode.value"
      :goal-mode="client.goalMode.value"
      :models="client.models.value"
      :auth-ready="client.authReady.value"
      :managed-signed-in="client.managedProviderStatus.value === 'authenticated'"
      :managed-membership="client.managedMembership.value"
      :starred-ids="client.starredModelIds.value"
      :skills="client.skills.value"
      :questions="client.questions.value"
      :pending-question-actions="client.pendingQuestionActions"
      :pending-approval-actions="client.pendingApprovalActions"
      :running="running"
      :overlay-open="anyOverlayOpen"
      :turn-active="client.turnActive.value"
      :queued="client.queued.value"
      :search-files="client.searchFiles"
      :upload-image="client.uploadImage"
      :working="client.working.value"
      :last-turn-reason="activeLastTurnReason"
      :turn-error="client.activeTurnError.value ?? null"
      :turn-retry="client.activeTurnRetry.value ?? null"
      :starting="client.isStartingFirstPrompt.value"
      :file-reload-key="client.activeSessionId.value"
      :session-loading="client.sessionLoading.value"
      :compaction="client.compaction.value"
      :has-more-messages="client.hasMoreMessages.value"
      :loading-more="client.loadingMoreMessages.value"
      :loading-more-error="client.loadMoreMessagesError.value"
      :load-older-messages="client.loadOlderMessages"
      :workspace-name="client.visibleWorkspace.value?.name"
      :workspace-root="client.visibleWorkspace.value?.root ?? client.status.value.cwd"
      :git-diff-stats="client.gitDiffStats.value"
      :workspaces="client.workspacesView.value"
      :active-workspace-id="client.activeWorkspaceId.value"
      :session-title="activeSessionTitle"
      :pr="client.activePullRequest.value"
      @open-changes="openDiffDetail()"
      @select-workspace="handleDraftWorkspaceSelect($event)"
      @add-workspace="runShortcutAction('openFolder', 'button')"
      @open-pr="openPr"
      @submit="handleSubmit($event)"
      @login="openLogin()"
      @steer="client.steerPrompt($event.text, $event.attachments)"
      @approval="(approvalId, response) => client.respondApproval(approvalId, response)"
      @cancel-task="client.cancelTask($event)"
      @answer="(questionId, response) => client.respondQuestion(questionId, response)"
      @dismiss="(questionId) => client.dismissQuestion(questionId)"
      @command="handleCommand"
      @interrupt="handleInterrupt"
      @unqueue="handleUnqueue"
      @edit-queued="handleEditQueued"
      @reorder-queue="handleReorderQueue"
      @set-permission="client.setPermission($event)"
      @set-thinking="client.setThinking($event)"
      @toggle-plan="client.togglePlanMode()"
      @toggle-swarm="client.toggleSwarmMode()"
      @toggle-goal="client.toggleGoalMode()"
      @create-goal="handleCreateGoal"
      @control-goal="client.controlGoal($event)"
      @refresh-git-status="client.activeSessionId.value && client.loadGitStatus(client.activeSessionId.value)"
      @rename-session="(id, title) => client.renameSession(id, title)"
      @fork-session="(id) => client.forkSession(id)"
      @archive-session="archiveSessionWithToast($event)"
      @export-session="(id) => void exportSessionWithToast(id)"
      @compact="client.compact()"
      @pick-model="openModelPicker()"
      @select-model="handleComposerSelectModel($event)"
      @open-file="openFilePreview($event)"
      @open-media="onOpenMedia"
      @open-turn-diff="openTurnDiff($event)"
      @open-compaction="openCompactionPanel($event)"
      @open-agent="openAgentPanel($event)"
      @edit-message="handleEditMessage"
    />

    <!-- Sidebar toggle — floating only when the platform control can't serve:
         on macOS desktop it's RESIDENT (always rendered beside the traffic
         lights, the sidebar slides underneath and only the glyph swaps, so it
         never moves or flashes); Windows owns a resident toggle in its global
         titlebar and never renders this control; web renders it only while
         COLLAPSED (to re-expand the sidebar). It must come AFTER
         ConversationPane in the DOM: Electron computes the window-drag region
         in tree order (drag rects union, no-drag rects subtract), so a no-drag
         element placed before the ChatHeader drag region would have its hole
         painted back over — making the button an inert drag area. -->
    <IconButton
      v-if="!isMobile && (isMacosDesktop || (sidebarCollapsed && !isWindowsDesktop))"
      class="sidebar-toggle-btn"
      size="sm"
      :label="sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')"
      :tooltip="sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')"
      @click="runShortcutAction('toggleSidebar', 'button')"
    >
      <Icon :name="sidebarCollapsed ? 'panel-expand' : 'panel-collapse'" />
    </IconButton>

    <!-- New-chat shortcut — web-only while the sidebar is COLLAPSED (the
         expanded sidebar already owns the primary "New chat" button).
         Windows deliberately keeps this action out of the global titlebar. -->
    <IconButton
      v-if="!isMobile && sidebarCollapsed && !isWindowsDesktop"
      class="new-chat-btn"
      size="sm"
      :label="t('sidebar.newChat')"
      :tooltip="t('sidebar.newChat')"
      @click="runShortcutAction('newSession', 'button')"
    >
      <Icon name="chat-new" />
    </IconButton>

    <ResizeHandle
      v-if="sidePanelVisible && !isMobile"
      class="preview-handle"
      :storage-key="PREVIEW_WIDTH_KEY"
      :default-width="previewDefaultWidth"
      :min="PREVIEW_MIN"
      :max="previewMax"
      reverse
      :aria-label="t('layout.resizePreviewAria')"
      :apply-live="applyPreviewWidthLive"
      @update:width="previewWidth = $event"
      @update:dragging="panelDragging = $event"
    />

    <!-- Desktop: the aside is a PERMANENT grid column whose width transitions
         0 ↔ var(--preview-w) — opening genuinely squeezes the chat column over
         (one animation, no slide-over hacks). Mobile mounts only when open
         (full-screen overlay). Content stays v-if'd, so a closed panel is a
         zero-width empty shell. -->
    <aside
      v-if="!isMobile || sidePanelVisible"
      ref="previewPanelEl"
      class="global-preview"
      :class="{ open: sidePanelVisible, mobile: isMobile }"
      role="complementary"
      :aria-label="t('layout.detailPanelAria')"
      :aria-hidden="!sidePanelVisible"
    >
      <ThinkingPanel
        v-if="detailTarget === 'compaction' && compactionPanelVisible"
        :text="compactionPanelText ?? ''"
        :subtitle="t('conversation.summaryTitle')"
        @close="closeCompactionPanel"
      />
      <AgentDetailPanel
        v-else-if="detailTarget === 'agent' && agentPanelMember"
        :member="agentPanelMember"
        :turns="agentPanelTurns"
        :running="agentPanelRunning"
        :loading="agentPanelLoading"
        :load-error="agentPanelLoadError"
        :has-more="agentPanelHasMore"
        :loading-more="agentPanelLoadingMore"
        :load-more-error="agentPanelLoadMoreError"
        @close="closeAgentPanel"
        @load-older-messages="loadOlderAgentMessages"
        @open-agent="openAgentPanel"
        @open-file="openFilePreview"
        @open-media="onOpenMedia"
        @open-turn-diff="openTurnDiff($event)"
      />
      <SideChatPanel
        v-else-if="detailTarget === 'btw' && btwVisible"
        :turns="client.sideChatTurns.value"
        :running="client.sideChatRunning.value"
        :sending="client.sideChatSending.value"
        @send="client.sendSideChatPrompt($event)"
        @close="closeSideChat"
        @open-media="onOpenMedia"
      />
      <DiffView
        v-else-if="detailTarget === 'diff'"
        :mode="detailDiffMode"
        :changes="client.changes.value"
        :git-info="client.gitInfo.value"
        :file-diff="client.fileDiff.value"
        :full-texts="client.fileDiffTexts.value"
        :empty-file="client.fileDiffEmptyFile.value"
        :selected-diff-path="client.selectedDiffPath.value"
        :file-diff-loading="client.fileDiffLoading.value"
        closable
        @open="selectDiffFile"
        @back="detailDiffMode = 'list'; detailDiffPath = null; client.clearFileDiff()"
        @close="closeDiffDetail"
      />
      <FilePreview
        v-else-if="detailTarget === 'file'"
        :file="previewFile"
        :loading="previewLoading"
        :error="previewError"
        :line="previewTarget?.line"
        :download-url="previewDownloadUrl"
        closable
        :external-actions="previewExternalActions"
        :open-file="openFilePreview"
        @close="closeFilePreview"
        @open-external="openPreviewInEditor"
        @reveal="revealPreviewFile"
      />
      <TurnDiffPanel
        v-else-if="detailTarget === 'turn-diff' && turnDiffChange"
        :change="turnDiffChange"
        :cwd="client.status.value.cwd"
        closable
        @close="closeTurnDiff"
        @open-file="openFilePreview({ path: $event })"
      />
    </aside>

    <!-- Desktop-only native terminal: permanent bottom grid row (design:
         docs/plans/2026-07-27-desktop-native-terminal.md). Kept mounted after
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
      <TerminalPanel :cwd="terminalCwd" />
    </section>

    <!-- Model Picker overlay -->
    <ModelPicker
      v-if="showModelPicker"
      :models="client.models.value"
      :current="client.status.value.modelId"
      :starred-ids="client.starredModelIds.value"
      :loading="modelsLoading"
      :unavailable="modelsUnavailable"
      @select="handleSelectModel($event)"
      @toggle-star="client.toggleStarModel($event)"
      @close="showModelPicker = false"
    />

    <!-- Settings page (modal) -->
    <SettingsDialog
      v-if="showSettings"
      :color-scheme="client.colorScheme.value"
      :font-scale="client.fontScale.value"
      :managed-provider-status="client.managedProviderStatus.value"
      :managed-user-info="client.managedUserInfo.value"
      :on-fetch-usage="client.getUsage"
      :notify="client.notifyEnabled.value"
      :notify-permission="client.notifyPermission.value"
      :notify-sound="client.notifySound.value"
      :config="client.config.value"
      :models="client.models.value"
      :config-saving="configSaving"
      :server-version="client.serverVersion.value"
      :backend="client.backend.value"
      :experimental-flags="client.experimentalFlags.value"
      :initial-tab="settingsInitialTab"
      @set-color-scheme="setColorSchemeFromSettings($event)"
      @set-font-scale="setFontScaleFromSettings($event)"
      @set-notify="client.setNotifyEnabled($event)"
      @set-notify-sound="client.setNotifySound($event)"
      @update-config="handleUpdateConfig($event)"
      @login="() => { showSettings = false; openLogin(); }"
      @logout="confirmLogout"
      @close="showSettings = false; settingsInitialTab = undefined"
    />

    <!-- Status panel overlay (/status) — renders current client state, no daemon call -->
    <StatusPanel
      v-if="showStatusPanel"
      :status="client.status.value"
      :thinking="statusPanelThinking"
      :plan-mode="client.planMode.value"
      :swarm-mode="client.swarmMode.value"
      :cost-usd="client.sessionCost.value"
      @close="showStatusPanel = false"
    />

    <!-- Add Workspace overlay (daemon folder browser + paste-path fallback) -->
    <AddWorkspaceDialog
      v-if="showAddWorkspace"
      :browse-fs="client.browseFs"
      :get-fs-home="client.getFsHome"
      :default-path="client.visibleWorkspace.value?.root ?? client.status.value.cwd"
      :error="addWorkspaceError"
      @add="handleAddWorkspace($event)"
      @close="handleCloseAddWorkspace"
    />

    <!-- Global connecting splash on first load (until the daemon round-trips) -->
    <Transition name="gload-fade">
      <GlobalLoading v-if="!client.initialized.value" :issue="client.connectIssue.value" />
    </Transition>

    <!-- Floating warnings / agent errors (e.g. a 403 from the model provider).
         Teleported to body: #app is position:fixed, which forms its own
         stacking context and would trap the toast z-index under any overlay
         (the Dialog primitive teleports to body for the same reason). -->
    <Teleport to="body">
      <WarningToasts :warnings="client.warnings.value" @dismiss="client.dismissWarning" />
      <!-- Action toast (top-center, design-system §03): one shared channel —
           the archive undo toast and the export result toast replace each
           other so two fixed pills never overlap. The export 'running' state
           only appears for genuinely slow exports (>=400ms). -->
      <Transition name="action-toast">
        <ActionToast
          v-if="actionToast"
          :key="actionToast.key"
          :duration="actionToast.kind === 'export' ? (actionToast.state === 'running' ? 60000 : 4000) : 8000"
          :dismiss-token="actionToast.key"
          @dismiss="dismissActionToast"
        >
          <template v-if="actionToast.kind === 'archive'">
            <button type="button" @click="undoArchive">{{ t('sidebar.archiveToastUndo') }}</button>
            {{ t('sidebar.archiveToastMid') }}
            <button type="button" @click="openArchivedSettings">{{ t('sidebar.archiveToastSettings') }}</button>
            {{ t('sidebar.archiveToastTail') }}
          </template>
          <template v-else>
            {{ actionToast.state === 'running' ? t('commands.export.started') : t('commands.export.done') }}
          </template>
        </ActionToast>
      </Transition>
    </Teleport>

    <!-- KAP/daemon debug panel (opt-in, ?debug=1) -->
    <DebugPanel v-if="debugEnabled" />

    <!-- Global modal-confirmation host (driven by useConfirmDialog) -->
    <ConfirmDialogHost />

    <!-- Mobile switcher bottom-sheet: workspace groups + sessions (mirrors the
         desktop sidebar) -->
    <MobileSwitcherSheet
      v-if="isMobile"
      v-model="showMobileSwitcher"
      :groups="client.mobileWorkspaceGroups.value"
      :active-workspace-id="client.activeWorkspaceId.value"
      :active-id="client.activeSessionId.value"
      :attention-by-session="client.attentionBySession.value"
      :attention-by-workspace="client.attentionByWorkspace.value"
      @select="handleSelectSession($event)"
      @create="runShortcutAction('newSession', 'button')"
      @create-in-workspace="handleCreateSessionInWorkspace($event)"
      @add-workspace="runShortcutAction('openFolder', 'button')"
      @rename="(id, title) => client.renameSession(id, title)"
      @archive="archiveSessionWithToast($event)"
      @delete-workspace="confirmDeleteWorkspace($event)"
      @load-more="(id) => void client.loadMoreSessions(id)"
    />

    <!-- Mobile settings bottom-sheet: session controls + app prefs + auth -->
    <MobileSettingsSheet
      v-if="isMobile"
      v-model="showMobileSettings"
      :initial-view="mobileSettingsInitialView"
      :status="client.status.value"
      :thinking="client.thinking.value"
      :models="client.models.value"
      :plan-mode="client.planMode.value"
      :swarm-mode="client.swarmMode.value"
      :color-scheme="client.colorScheme.value"
      :font-scale="client.fontScale.value"
      :managed-provider-status="client.managedProviderStatus.value"
      :managed-user-info="client.managedUserInfo.value"
      :server-version="client.serverVersion.value"
      @pick-model="openModelPicker()"
      @set-thinking="client.setThinking($event)"
      @toggle-plan="client.togglePlanMode()"
      @toggle-swarm="client.toggleSwarmMode()"
      @set-permission="client.setPermission($event)"
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
      v-if="client.initialized.value && showOnboarding"
      :auth-ready="client.managedProviderStatus.value === 'authenticated'"
      :on-start-o-auth-login="handleStartOAuthLogin"
      :on-poll-o-auth-login="handlePollOAuthLogin"
      :on-cancel-o-auth-login="handleCancelOAuthLogin"
      @complete="completeOnboarding"
      @login-success="handleWizardLoginSuccess"
      @add-provider="handleWizardAddProvider"
    />
    <!-- Login Dialog overlay. It is outside `.app` so `/login` can open it too. -->
    <LoginDialog
      v-if="showLogin"
      :on-start-o-auth-login="handleStartOAuthLogin"
      :on-poll-o-auth-login="handlePollOAuthLogin"
      :on-cancel-o-auth-login="handleCancelOAuthLogin"
      @success="handleLoginSuccess"
      @close="showLogin = false"
    />
    <!-- Floating preview for tool-card media (image/video). The component
         teleports its own overlays, so mounting inside `.app` is safe. -->
    <MediaLightbox
      v-if="mediaLightbox"
      :media="mediaLightbox"
      :origin-img="mediaLightboxImg"
      @close="
        mediaLightbox = null;
        mediaLightboxImg = null;
      "
    />
  </div>
</template>

<style scoped>
/* Global connecting splash fade-out (only the leave matters; it mounts instantly). */
.gload-fade-leave-active { transition: opacity 0.28s ease; }
.gload-fade-leave-to { opacity: 0; }

/* Archive undo toast enter/leave: fade + a slight settle from above. */
.action-toast-enter-active,
.action-toast-leave-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.action-toast-leave-active {
  transition-duration: var(--duration-fast);
  /* A replaced toast keeps animating out over the live one — keep the leaving
     instance inert so its Undo/Settings/close can't act on (or clear) the
     newer toast (same rule as the menu-pop transition). */
  pointer-events: none;
}
.action-toast-enter-from,
.action-toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.app-shell {
  /* Pinned to the visual viewport (see setAppHeight): --app-top tracks iOS's
     keyboard pan and --app-height shrinks with the keyboard, so the shell
     always covers exactly the visible area. Fixed positioning keeps it out of
     the document flow that iOS pans. */
  position: fixed;
  top: var(--app-top, 0px);
  left: 0;
  right: 0;
  height: 100vh;
  height: 100dvh;
  height: var(--app-height, 100dvh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
}
.app {
  --windows-titlebar-height: env(titlebar-area-height, 40px);
  flex: 1;
  min-height: 0;
  position: relative;
  display: grid;
  /* sidebar | 0-width handle | conversation | 0-width handle | right panel.
     The 4px ResizeHandles overflow their zero-width tracks via negative margins
     so the whole strip is grabbable without consuming layout space. */
  /* Both side tracks are PERMANENT (auto = follows the aside's width, 0 when
     closed/collapsed) — opening or collapsing animates the aside's width, so
     the conversation column is squeezed over smoothly instead of snapping to a
     new template. Every column is pinned explicitly (grid-column 1–5) so a
     display:none handle can't shift auto-placement. */
  grid-template-columns: auto 0 minmax(0, 1fr) 0 auto;
  /* Row 1: the whole app chrome (sidebar / conversation / right panel).
     Row 2: the bottom terminal panel (auto = follows its own height, 0 when
     collapsed) — desktop-only, see .terminal-panel. */
  grid-template-rows: minmax(0, 1fr) auto;
  background: var(--bg);
  color: var(--color-text);
  overflow: hidden;
  box-sizing: border-box;
}
.app.windows-desktop:not(.fullscreen) {
  padding-top: var(--windows-titlebar-height);
}
/* macOS desktop with the frosted material on: unpainted — the window's
   native vibrancy material reads through the sidebar column (see style.css
   html.macos-desktop.vibrancy); the conversation (.con), chat header and
   right preview paint themselves. */
.app.macos-desktop.vibrancy {
  background: transparent;
}
/* Grid children must be allowed to shrink below content height so that only
   the inner scroll containers (.panes / .sessions) scroll — otherwise the
   whole .app overflows and the page (incl. sidebar) scrolls together. */
.app > * {
  min-height: 0;
  min-width: 0;
}

/* Pin every desktop grid child to its track so auto-placement can never
   reshuffle columns when a handle is display:none (v-show/v-if). The sidebar
   and the right panel span BOTH rows — the terminal panel only takes the
   conversation column's bottom slot (VS Code layout: panel sits under the
   editor, side chrome keeps full height). */
.app > .side { grid-column: 1; grid-row: 1 / -1; }
.side-handle { grid-column: 2; grid-row: 1 / -1; }
.app:not(.mobile) > .con { grid-column: 3; grid-row: 1; }
.preview-handle { grid-column: 4; grid-row: 1 / -1; }

/* Sidebar toggle — floating button pinned to the top-left corner. On macOS
   desktop it is resident (rendered in both states beside the traffic lights);
   on Windows/web it only appears while the sidebar is collapsed (the collapse
   button lives inside the sidebar header). While collapsed the conversation
   header pads left so its content clears the button (global block below). */
.sidebar-toggle-btn {
  position: absolute;
  /* Vertically centered in the 48px conversation header. */
  top: 11px;
  left: 16px;
  z-index: var(--z-sticky);
  /* Fade in on appearance (Windows/web: only rendered while collapsed, so
     this plays as the sidebar finishes sliding away). macOS disables it. */
  animation: sidebar-toggle-btn-in 0.18s var(--ease-out) 0.12s backwards;
  /* Floats over the macOS-desktop window-drag header; keep it clickable. */
  -webkit-app-region: no-drag;
}
/* macOS desktop (hidden title bar): resident beside the floating traffic
   lights. Measured on-screen (titleBarStyle 'hidden', trafficLightPosition
   x 16): the green light's center lands at ≈ 69px, its right edge at ≈ 75px —
   84 keeps ≈ 9px of clear air to the button (the lights' own circle-to-circle
   rhythm is 8px); the old 72px put the button 3px from the green dot and read
   cramped. No entrance animation since it never appears. */
.app.macos-desktop .sidebar-toggle-btn {
  left: 84px;
  animation: none;
}
/* macOS full-screen: the traffic lights hide (they only re-appear as a
   transient overlay while the pointer sits at the screen's top edge), so the
   resident toggle drops the lights' slot and hugs the window edge — same 16px
   as the default (non-mac) floating position. */
.app.macos-desktop.fullscreen .sidebar-toggle-btn {
  left: 16px;
}
/* Collapsed-state "new chat" shortcut — flush against the toggle's right
   edge (26px button, no gap). Rendered only while collapsed on every
   platform, so unlike the resident macOS toggle it keeps the entrance
   animation. */
.new-chat-btn {
  position: absolute;
  /* Vertically centered in the 48px conversation header. */
  top: 11px;
  left: 42px;
  z-index: var(--z-sticky);
  animation: sidebar-toggle-btn-in 0.18s var(--ease-out) 0.12s backwards;
  /* Floats over the macOS-desktop window-drag header; keep it clickable. */
  -webkit-app-region: no-drag;
}
.app.macos-desktop .new-chat-btn {
  left: 110px;
}
/* Follows the toggle's fullscreen shift (toggle at 16px + 26px). */
.app.macos-desktop.fullscreen .new-chat-btn {
  left: 42px;
}
@keyframes sidebar-toggle-btn-in {
  from { opacity: 0; }
}

/* Mobile single-column shell: slim top bar (auto) over the full-width
   conversation pane (1fr). No rail, no session column, no resize handle. */
.app.mobile {
  grid-template-columns: 1fr;
  grid-template-rows: auto 1fr;
}

/* The right-side panel column: a permanent grid item whose width toggles
   0 ↔ var(--preview-w) with no transition — animating a grid track relayouts
   the whole app grid every frame. The CONTENT keeps a fixed width (and carries
   the left hairline) so resize drags never reflow it. */
/* --preview-w lives on this element (set inline), NOT on the .app root:
   a custom property change invalidates every inheriting descendant's style,
   so scoping it here keeps resize-drag style recalculation inside the panel
   subtree instead of spanning the whole app. */
.global-preview {
  --preview-w: 460px;
  grid-column: 5;
  grid-row: 1 / -1;
  min-width: 0;
  min-height: 0;
  width: 0;
  background: var(--bg);
  overflow: hidden;
}
.global-preview.open {
  width: var(--preview-w);
}
.global-preview:not(.mobile) > * {
  width: var(--preview-w);
  height: 100%;
  box-sizing: border-box;
  border-left: 0.5px solid var(--line);
}
.global-preview.mobile {
  position: fixed;
  inset: 0;
  z-index: var(--z-sticky);
  width: auto;
  transition: none;
  border-top: 0.5px solid var(--color-text);
}

/* The bottom terminal panel row (desktop-only): same 0 ↔ var(--terminal-h)
   transition mechanism as the right aside. It occupies ONLY the conversation
   column's bottom slot — the sidebar and right panel span both rows above.
   --terminal-h lives on this element (set inline), scoping drag-time style
   recalculation to the panel subtree. */
.terminal-panel {
  --terminal-h: 260px;
  grid-column: 3;
  grid-row: 2;
  min-height: 0;
  height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border-top: 0.5px solid transparent;
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
/* The mobile layout has no terminal panel (its toggle is a no-op there) —
   hide rather than unmount so xterm scrollback survives a viewport dip. */
.app.mobile .terminal-panel {
  display: none;
}
</style>

<style>
:root {
  /* Right-side panel headers (ThinkingPanel / FilePreview / DiffView / SideChatPanel)
     share the same 48px height as the conversation header so the hairline reads as
     one continuous line across the layout. */
  --panel-head-h: 48px;
  /* Inset of the header's sm icon buttons from the header edges — derived (not
     hardcoded) so the PanelHeader close slot stays equidistant from the top
     and right edges when the header height or the button size changes. */
  --panel-head-inset: calc((var(--panel-head-h) - var(--icon-button-sm)) / 2);
}

/* Sidebar collapsed (desktop): the conversation header pads left so its
   content clears the floating sidebar toggle (.sidebar-toggle-btn) and the
   new-chat shortcut (.new-chat-btn) beside it — plus the macOS traffic lights
   on desktop builds. Animated in step with the sidebar width transition.
   Cross-component rule (ChatHeader renders the header), so it lives in this
   global block. */
.app:not(.mobile) .chat-header {
  transition: padding-left 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}
.app.sidebar-collapsed .chat-header {
  padding-left: 78px;
}
.app.sidebar-collapsed.windows-desktop .chat-header {
  padding-left: var(--space-4);
}
.app.sidebar-collapsed.macos-desktop .chat-header {
  padding-left: 146px;
}
/* Full-screen follow-up to the rule above: with the traffic lights hidden the
   buttons shift to the window edge (toggle at 16px, new-chat at 42px), so the
   header padding falls back to the non-mac collapsed value. */
.app.fullscreen.sidebar-collapsed.macos-desktop .chat-header {
  padding-left: 78px;
}

/* macOS desktop (hidden title bar): the right panel's header row continues the
   conversation header's 48px top strip, so it joins the window-drag region.
   Interactive controls inside opt out (same pattern as ChatHeader). Cross-
   component rule (the header is app-ui's PanelHeader), so it lives here. */
.app.macos-desktop .global-preview .ui-panel-header {
  -webkit-app-region: drag;
}
.app.macos-desktop .global-preview .ui-panel-header button,
.app.macos-desktop .global-preview .ui-panel-header input {
  -webkit-app-region: no-drag;
}

/* While a transient overlay opened from the page is up (the kebab more-menu,
   the open-in menu, a dock work panel), drop EVERY window-drag region: in a
   drag region macOS consumes the press for window dragging, so the page
   never sees the mousedown and the overlay's outside-click dismiss never
   fires — no matter which drag strip (chat header, sidebar header, panel
   header) the user clicks. Window dragging is simply paused while the
   overlay is open. Cross-component by nature, so it lives in this global
   block. (The empty-state .empty-drag band needs no carve-out: with no
   ChatHeader rendered there is no menu to dismiss.) */
.app.macos-desktop:has(.ch-menu, .open-in-menu, .dock-work-panel) .chat-header,
.app.macos-desktop:has(.ch-menu, .open-in-menu, .dock-work-panel) .side .ch,
.app.macos-desktop:has(.ch-menu, .open-in-menu, .dock-work-panel) .global-preview .ui-panel-header {
  -webkit-app-region: no-drag;
}
</style>
