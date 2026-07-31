<!-- apps/kimi-web/src/App.vue -->
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
import ModelPicker from './components/settings/ModelPicker.vue';
import ProviderManager from './components/settings/ProviderManager.vue';
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
import { useConfirmDialog } from './composables/useConfirmDialog';
import type { PromptAttachment } from './composables/useKimiWebClient';
import type { TurnAttachment } from './types';
import { usePageTitle } from './composables/usePageTitle';
import { useSidebarLayout } from './composables/useSidebarLayout';
import { useFilePreview, type DetailTarget } from './composables/useFilePreview';
import { useDetailPanel } from './composables/useDetailPanel';
import { useIsMobile } from './composables/useIsMobile';
import { openDialogCount } from '@moonshot-ai/web-ui';
import type { SwarmMember } from './composables/swarmGroups';
import ServerAuthDialog from './components/ServerAuthDialog.vue';
import { initServerAuth, onAuthRequired } from './lib/serverAuth';
import type { AppConfig, ThinkingLevel } from './api/types';
import { commitLevel, effectiveThinkingLevel, segmentsFor } from './lib/modelThinking';
import { stripSkillPrefix } from './lib/slashCommands';
import { ActionToast, Icon, IconButton } from '@moonshot-ai/web-ui';
import InternalBuildBanner from './components/InternalBuildBanner.vue';
import { isMacosDesktop } from './lib/desktopFlag';
import { openUpgrade } from './lib/upgrade';

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
const { t } = useI18n();
const { confirm } = useConfirmDialog();

// KAP/daemon debug panel — opt-in via ?debug=1 or localStorage kimi-web.debug=1.
const debugEnabled = isTraceEnabled();

// Narrow viewports (≤640px) render the single-column mobile shell; desktop is
// unchanged. Falls back to desktop when matchMedia is unavailable.
const isMobile = useIsMobile();

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
  // Capture-phase so Escape closes the side detail layer BEFORE the
  // conversation pane's bubble-phase handler interrupts a running prompt.
  document.addEventListener('keydown', onGlobalKeydown, true);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown, true);
  window.visualViewport?.removeEventListener('resize', syncAppHeight);
  window.visualViewport?.removeEventListener('scroll', syncAppHeight);
  window.removeEventListener('resize', syncAppHeight);
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
  // A modal dialog open on top of the side panel owns Escape — leave the event
  // alone so the dialog can close itself instead of the panel behind it.
  if (anyOverlayOpen.value) return;
  if (closeOpenSidePanel()) {
    e.stopPropagation();
    e.preventDefault();
  }
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
  openMediaPreview,
  closeFilePreview,
  openPreviewInEditor,
  revealPreviewFile,
} = useFilePreview({ client, detailTarget });

// True while the right-side slot is actually occupied, so the sidebar reserves
// room for it and the conversation can never be squeezed. Keyed off detailTarget
// (the real occupant) rather than previewTarget, which can stay set after the
// panel is hidden.
const previewOpen = computed(() => detailTarget.value !== null);

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

// Reference to ConversationPane so we can imperatively switch tabs
const conversationPaneRef = ref<InstanceType<typeof ConversationPane> | null>(null);

// Dialog visibility refs
const showModelPicker = ref(false);
const showProviders = ref(false);

const showLogin = ref(false);
const showAddWorkspace = ref(false);
const showStatusPanel = ref(false);
const showSettings = ref(false);

// Desktop-only: native menu commands forward here over the preload bridge
// (main/menu.ts → kimi:menu-action): App menu "设置… / Settings…" →
// 'open-settings', File menu "新建会话 / New Chat" → 'new-chat'. The bridge
// exists only in Electron, so on web this is a no-op and the Sidebar's own
// Cmd/Ctrl+N keydown stays the only path (the no-bridge fallback, per
// native-todos.md).
let offMenuAction: (() => void) | undefined;
onMounted(() => {
  offMenuAction = (
    window as {
      kimiDesktop?: { onMenuAction?: (cb: (id: string) => void) => () => void };
    }
  ).kimiDesktop?.onMenuAction?.((id) => {
    if (id === 'open-settings') {
      showSettings.value = true;
    } else if (id === 'new-chat') {
      handleCreateSession();
    }
  });
});
onUnmounted(() => {
  offMenuAction?.();
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
    showProviders.value ||
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
const providersLoading = ref(false);
const providersUnavailable = ref(false);
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

async function openProviders(): Promise<void> {
  providersLoading.value = true;
  providersUnavailable.value = false;
  showProviders.value = true;
  try {
    await client.loadProviders();
  } catch {
    providersUnavailable.value = true;
  } finally {
    providersLoading.value = false;
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

async function handleAddProvider(input: { type: string; apiKey?: string; baseUrl?: string; defaultModel?: string }): Promise<void> {
  await client.addProvider(input);
  // Provider count feeds /auth readiness (the composer send gate) — refresh it
  // so a just-added provider unblocks sending without a full reload.
  await client.checkAuth();
}

async function handleRefreshProvider(id: string): Promise<void> {
  await client.refreshProvider(id);
}

// Destructive workspace/provider actions confirm through the shared modal
// here (the menu components only emit the intent). Each passes its work as
// the dialog `action`, so the dialog stays open with a loading state until
// the operation settles. Both client calls toast their own errors and never
// reject.
//
// Archive runs WITHOUT a confirm dialog: archive immediately, then show a
// top-center toast with Undo / Settings links (design-system §03 ActionToast).
// Every archive entry point (sidebar row, chat header, mobile switcher)
// funnels here. client.archiveSession toasts its own errors and never
// rejects, so a failed archive simply shows no undo toast.
const archiveToast = ref<{ id: string } | null>(null);

async function archiveSessionWithToast(id: string): Promise<void> {
  await client.archiveSession(id);
  // A failed archive keeps the session in the list — no toast then.
  if (client.sessionsForView.value.some((s) => s.id === id)) return;
  archiveToast.value = { id };
}

// Undo puts the session back at the front of the sidebar list (no
// re-selection). On failure the toast stays so the user can retry — the
// error itself surfaces via WarningToasts.
async function undoArchive(): Promise<void> {
  const toast = archiveToast.value;
  if (!toast) return;
  if (await client.restoreSession(toast.id)) archiveToast.value = null;
}

// Deep link into a settings tab (the archive undo toast opens Settings →
// Archived). Read once at SettingsDialog mount, then reset on close so later
// manual opens land on General again.
const settingsInitialTab = ref<'archived' | undefined>(undefined);
// Same deep link for the mobile settings sheet (its archived sub-view).
// Reset when the sheet closes so later manual opens land on the main view.
const mobileSettingsInitialView = ref<'archived' | undefined>(undefined);
watch(showMobileSettings, (open) => {
  if (!open) mobileSettingsInitialView.value = undefined;
});

// "Settings" deep-links to the archived-sessions tab (desktop dialog) or
// sub-view (mobile sheet).
function openArchivedSettings(): void {
  archiveToast.value = null;
  if (isMobile.value) {
    mobileSettingsInitialView.value = 'archived';
    showMobileSettings.value = true;
  } else {
    settingsInitialTab.value = 'archived';
    showSettings.value = true;
  }
}

async function confirmDeleteWorkspace(id: string): Promise<void> {
  const name = client.workspacesView.value.find((w) => w.id === id)?.name ?? id;
  await confirm({
    title: t('sidebar.removeWorkspace'),
    message: t('workspace.removeWorkspaceConfirm', { name }),
    variant: 'danger',
    action: () => client.deleteWorkspace(id),
  });
}

async function confirmDeleteProvider(id: string): Promise<void> {
  await confirm({
    title: t('providers.delete'),
    message: t('providers.confirmDelete'),
    variant: 'danger',
    // Refresh /auth readiness too — deleting the last provider must re-arm
    // the composer send gate.
    action: async () => {
      await client.deleteProvider(id);
      await client.checkAuth();
    },
  });
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
  // The userinfo probe is fire-and-forget: a signed-in account whose
  // membership is still unknown gets an awaited probe first, so a free
  // account inside the probe window isn't sent back to login.
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
// can resume. Resolves true when the caller may proceed.
async function passWorkspaceGateForCommand(text: string): Promise<boolean> {
  if (client.activeSessionId.value || client.activeWorkspaceId.value) return true;
  const pick = await confirm({
    title: t('workspace.requiredTitle'),
    message: t('workspace.requiredMessage'),
    confirmLabel: t('conversation.pickFolder'),
    variant: 'primary',
  });
  conversationPaneRef.value?.loadComposerForEdit(text);
  if (pick) showAddWorkspace.value = true;
  return false;
}

// Both gates, for command paths that submit work. `text` is the full command
// line, handed back to the composer when gated.
async function passCommandGates(text: string): Promise<boolean> {
  if (!(await passAuthGate(text, []))) return false;
  return passWorkspaceGateForCommand(text);
}

// Handler for slash commands emitted by Composer (via ConversationPane)
async function handleCommand(cmd: string): Promise<void> {
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
      void client.createGoal(arg);
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
      void openSideChatTab(arg || undefined);
    }
    return;
  }
  switch (cmd) {
    // `/new` and `/clear` are aliases: both open the onboarding composer. The
    // session is only created when the user sends the first message.
    case '/new':
    case '/clear':
      handleCreateSession();
      break;
    case '/fork':
      void client.forkSession();
      break;
    case '/export':
      void client.exportSession();
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
      // With no active session, create one first (same path as the first
      // prompt) so the activation isn't silently dropped on the new-session
      // screen.
      const space = cmd.indexOf(' ');
      const name = stripSkillPrefix((space === -1 ? cmd : cmd.slice(0, space)).slice(1));
      const args = space === -1 ? undefined : cmd.slice(space + 1).trim() || undefined;
      if (!name) break;
      if (!(await passCommandGates(cmd))) return;
      if (!client.activeSessionId.value && client.activeWorkspaceId.value) {
        void client.startSessionAndActivateSkill(client.activeWorkspaceId.value, name, args);
      } else {
        void client.activateSkill(name, args);
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
    await client.startSessionAndSendPrompt(wsId, payload.text, payload.attachments);
    return;
  }
  if (!client.activeSessionId.value && !wsId) {
    pendingWorkspaceSubmit.value = payload;
    // Ask first — never jump straight into the folder picker.
    const pick = await confirm({
      title: t('workspace.requiredTitle'),
      message: t('workspace.requiredMessage'),
      confirmLabel: t('conversation.pickFolder'),
      variant: 'primary',
    });
    if (pick) {
      showAddWorkspace.value = true;
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

async function handleAddWorkspace(root: string): Promise<void> {
  addWorkspaceError.value = null;
  const added = await client.addWorkspaceByPath(root);
  // Keep the picker open (and the pending submission intact) when the daemon
  // rejects the path so the user can retry with a valid one. The error is shown
  // inline in the picker. Closing via Escape goes through handleCloseAddWorkspace,
  // which drops the pending prompt.
  if (!added) {
    addWorkspaceError.value = t('workspace.addFailed');
    return;
  }
  showAddWorkspace.value = false;
  const pending = pendingWorkspaceSubmit.value;
  pendingWorkspaceSubmit.value = null;
  const wsId = client.activeWorkspaceId.value;
  if (pending && wsId) {
    await client.startSessionAndSendPrompt(wsId, pending.text, pending.attachments);
  }
}

function handleCloseAddWorkspace(): void {
  dropPendingWorkspaceSubmit();
  addWorkspaceError.value = null;
  showAddWorkspace.value = false;
}

function focusComposerAfterDraft(): void {
  void nextTick(() => {
    conversationPaneRef.value?.focusComposer();
  });
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
  client.openWorkspaceDraft(workspaceId);
  focusComposerAfterDraft();
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
      }"
      :inert="showOnboarding"
    >
    <!-- Desktop navigation: workspace rail + resizable session column. -->
    <template v-if="!isMobile">
      <Sidebar
        :collapsed="sidebarCollapsed"
        :dragging="sidebarDragging"
        :col-width="sideWidth"
        :active-workspace="client.visibleWorkspace.value"
        :active-workspace-id="client.activeWorkspaceId.value"
        :sessions="client.sessionsForView.value"
        :groups="client.workspaceGroups.value"
        :pinned-sessions="client.pinnedSessions.value"
        :active-id="client.activeSessionId.value"
        :attention-by-session="client.attentionBySession.value"
        :pending-by-session="client.pendingBySession.value"
        :unread-by-session="client.unreadBySession.value"
        :backend="client.backend.value"
        @select="client.selectSession($event)"
        @create="handleCreateSession"
        @create-in-workspace="handleCreateSessionInWorkspace($event)"
        @select-workspace="client.openWorkspace($event)"
        @add-workspace="showAddWorkspace = true"
        @rename="(id, title) => client.renameSession(id, title)"
        @archive="archiveSessionWithToast($event)"
        @fork="(id) => client.forkSession(id)"
        @export="(id) => client.exportSession(id)"
        @pin="client.togglePinSession($event)"
        @unpin="client.unpinSession($event)"
        @reorder-pinned="client.reorderPinnedSessions($event)"
        @pin-at="(id, targetId, position) => client.pinSessionAt(id, targetId, position)"
        @rename-workspace="(id, name) => client.renameWorkspace(id, name)"
        @delete-workspace="confirmDeleteWorkspace($event)"
        @reorder-workspaces="client.reorderWorkspaces($event)"
        @load-more-sessions="(id) => void client.loadMoreSessions(id)"
        @load-all-sessions="void client.loadAllSessions()"
        @open-settings="showSettings = true"
        @login="openLogin"
        @collapse="toggleSidebarCollapse"
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
      @open-settings="showMobileSettings = true"
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
      @select-workspace="handleCreateSessionInWorkspace($event)"
      @add-workspace="showAddWorkspace = true"
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
      @create-goal="client.createGoal($event)"
      @control-goal="client.controlGoal($event)"
      @refresh-git-status="client.activeSessionId.value && client.loadGitStatus(client.activeSessionId.value)"
      @rename-session="(id, title) => client.renameSession(id, title)"
      @fork-session="(id) => client.forkSession(id)"
      @archive-session="archiveSessionWithToast($event)"
      @export-session="(id) => client.exportSession(id)"
      @compact="client.compact()"
      @pick-model="openModelPicker()"
      @select-model="handleComposerSelectModel($event)"
      @open-file="openFilePreview($event)"
      @open-media="openMediaPreview($event)"
      @open-turn-diff="openTurnDiff($event)"
      @open-compaction="openCompactionPanel($event)"
      @open-agent="openAgentPanel($event)"
      @edit-message="handleEditMessage"
    />

    <!-- Sidebar toggle — floating only when the in-header control can't serve:
         on macOS desktop it's RESIDENT (always rendered beside the traffic
         lights, the sidebar slides underneath and only the glyph swaps, so it
         never moves or flashes); on Windows/web the collapse button lives
         inside the sidebar header, so this floating button only appears while
         COLLAPSED (to re-expand the sidebar). It must come AFTER
         ConversationPane in the DOM: Electron computes the window-drag region
         in tree order (drag rects union, no-drag rects subtract), so a no-drag
         element placed before the ChatHeader drag region would have its hole
         painted back over — making the button an inert drag area. -->
    <IconButton
      v-if="!isMobile && (isMacosDesktop || sidebarCollapsed)"
      class="sidebar-toggle-btn"
      size="sm"
      :label="sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')"
      @click="toggleSidebarCollapse"
    >
      <Icon :name="sidebarCollapsed ? 'panel-expand' : 'panel-collapse'" />
    </IconButton>

    <!-- New-chat shortcut — only while the sidebar is COLLAPSED (the expanded
         sidebar already owns the primary "New chat" button). Sits immediately
         right of the toggle and reuses its chat-new icon. -->
    <IconButton
      v-if="!isMobile && sidebarCollapsed"
      class="new-chat-btn"
      size="sm"
      :label="t('sidebar.newChat')"
      @click="handleCreateSession"
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
        @open-media="openMediaPreview"
        @open-turn-diff="openTurnDiff($event)"
      />
      <SideChatPanel
        v-else-if="detailTarget === 'btw' && btwVisible"
        :turns="client.sideChatTurns.value"
        :running="client.sideChatRunning.value"
        :sending="client.sideChatSending.value"
        @send="client.sendSideChatPrompt($event)"
        @close="closeSideChat"
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
        @open-file="openFilePreview({ path: $event, allowHostRead: true })"
      />
    </aside>

    <!-- Internal-build tag — pinned to the app's bottom-right corner, above
         whatever pane happens to be there. Purely informational: pointer
         events pass through so it never blocks clicks. -->
    <InternalBuildBanner class="internal-build-fab" />

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
      @set-color-scheme="client.setColorScheme($event)"
      @set-font-scale="client.setFontScale($event)"
      @set-notify="client.setNotifyEnabled($event)"
      @set-notify-sound="client.setNotifySound($event)"
      @update-config="handleUpdateConfig($event)"
      @login="() => { showSettings = false; openLogin(); }"
      @logout="confirmLogout"
      @open-providers="() => { showSettings = false; openProviders(); }"
      @close="showSettings = false; settingsInitialTab = undefined"
    />

    <!-- Provider Manager overlay -->
    <ProviderManager
      v-if="showProviders"
      :providers="client.providers.value"
      :loading="providersLoading"
      :unavailable="providersUnavailable"
      @add="handleAddProvider($event)"
      @refresh="handleRefreshProvider($event)"
      @delete="confirmDeleteProvider($event)"
      @open-login="() => { showProviders = false; openLogin(); }"
      @close="showProviders = false"
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

    <!-- Floating warnings / agent errors (e.g. a 403 from the model provider) -->
    <WarningToasts :warnings="client.warnings.value" @dismiss="client.dismissWarning" />

    <!-- Archive undo toast (top-center): archiving skips the confirm dialog;
         Undo restores the session, Settings opens the archived list.
         Teleported to body so it layers above the teleported dialogs. -->
    <Teleport to="body">
      <Transition name="action-toast">
        <ActionToast v-if="archiveToast" :key="archiveToast.id" @dismiss="archiveToast = null">
          <button type="button" @click="undoArchive">{{ t('sidebar.archiveToastUndo') }}</button>
          {{ t('sidebar.archiveToastMid') }}
          <button type="button" @click="openArchivedSettings">{{ t('sidebar.archiveToastSettings') }}</button>
          {{ t('sidebar.archiveToastTail') }}
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
      @select="client.selectSession($event)"
      @create="handleCreateSession"
      @create-in-workspace="handleCreateSessionInWorkspace($event)"
      @add-workspace="showAddWorkspace = true"
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
      @set-color-scheme="client.setColorScheme($event)"
      @set-font-scale="client.setFontScale($event)"
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
.action-toast-leave-active { transition-duration: var(--duration-fast); }
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
  background: var(--bg);
  color: var(--color-text);
  overflow: hidden;
  box-sizing: border-box;
}
/* Grid children must be allowed to shrink below content height so that only
   the inner scroll containers (.panes / .sessions) scroll — otherwise the
   whole .app overflows and the page (incl. sidebar) scrolls together. */
.app > * {
  min-height: 0;
  min-width: 0;
}

/* Pin every desktop grid child to its track so auto-placement can never
   reshuffle columns when a handle is display:none (v-show/v-if). */
.app > .side { grid-column: 1; }
.side-handle { grid-column: 2; }
.app:not(.mobile) > .con { grid-column: 3; }
.preview-handle { grid-column: 4; }

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
@keyframes sidebar-toggle-btn-in {
  from { opacity: 0; }
}

/* Internal-build tag pinned to the app's bottom-right corner (desktop app
   only — the component renders nothing elsewhere). Informational: never
   intercepts pointer input. */
.internal-build-fab {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  z-index: var(--z-sticky);
  pointer-events: none;
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
.app.sidebar-collapsed.macos-desktop .chat-header {
  padding-left: 146px;
}

/* macOS desktop (hidden title bar): the right panel's header row continues the
   conversation header's 48px top strip, so it joins the window-drag region.
   Interactive controls inside opt out (same pattern as ChatHeader). Cross-
   component rule (the header is web-ui's PanelHeader), so it lives here. */
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
