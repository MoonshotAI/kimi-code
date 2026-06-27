<!-- apps/kimi-web/src/App.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Sidebar from './components/Sidebar.vue';
import ResizeHandle from './components/ResizeHandle.vue';
import ConversationPane from './components/chat/ConversationPane.vue';
import FilePreview from './components/FilePreview.vue';
import ThinkingPanel from './components/chat/ThinkingPanel.vue';
import AgentDetailPanel from './components/chat/AgentDetailPanel.vue';
import ToolDiffPanel from './components/chat/ToolDiffPanel.vue';
import SideChatPanel from './components/chat/SideChatPanel.vue';
import DiffView from './components/chat/DiffView.vue';
import ModelPicker from './components/settings/ModelPicker.vue';
import ProviderManager from './components/settings/ProviderManager.vue';
import LoginDialog from './components/dialogs/LoginDialog.vue';
import NewSessionDialog from './components/dialogs/NewSessionDialog.vue';
import SettingsDialog from './components/settings/SettingsDialog.vue';
import SessionsDialog from './components/dialogs/SessionsDialog.vue';
import AddWorkspaceDialog from './components/dialogs/AddWorkspaceDialog.vue';
import StatusPanel from './components/chat/StatusPanel.vue';
import WarningToasts from './components/WarningToasts.vue';
import MobileTopBar from './components/mobile/MobileTopBar.vue';
import MobileSwitcherSheet from './components/mobile/MobileSwitcherSheet.vue';
import MobileSettingsSheet from './components/mobile/MobileSettingsSheet.vue';
import Onboarding from './components/settings/Onboarding.vue';
import GlobalLoading from './components/GlobalLoading.vue';
import DebugPanel from './debug/DebugPanel.vue';
import { isTraceEnabled } from './debug/trace';
import { useKimiWebClient } from './composables/useKimiWebClient';
import { useAuthGate } from './composables/useAuthGate';
import { usePageTitle } from './composables/usePageTitle';
import { useSidebarLayout } from './composables/useSidebarLayout';
import { useFilePreview, type DetailTarget } from './composables/useFilePreview';
import { useDetailPanel } from './composables/useDetailPanel';
import { useIsMobile } from './composables/useIsMobile';
import ServerAuthDialog from './components/ServerAuthDialog.vue';
import { initServerAuth, onAuthRequired } from './api/daemon/serverAuth';
import type { AppConfig, ThinkingLevel } from './api/types';

// Hydrate the server-transport credential (fragment token or sessionStorage)
// BEFORE the client connects, so the first REST/WS calls already carry it.
const hasServerCredential = initServerAuth();
const showServerAuth = ref(!hasServerCredential);
let offAuthRequired: (() => void) | null = null;

const client = useKimiWebClient();
provide('resolveImage', client.resolveImageUrl);
const { t } = useI18n();

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

// Number of sessions in the active workspace (mobile top-bar sub-line).
const activeWorkspaceSessionCount = computed<number>(
  () => client.visibleWorkspace.value?.sessionCount ?? 0,
);

// running: true when activity is not idle
const running = computed(() => client.activity.value !== 'idle');

// Auth readiness gates the main app. Once the first load finishes and auth is
// still missing, show a full-page login entry instead of an in-app banner.
const authLogoRef = ref<SVGSVGElement | null>(null);
const { showAuthGate, blinkAuthLogo } = useAuthGate({ client, authLogoRef });


// Static page title (app name only). The session title and workspace name are
// intentionally excluded so the tab title stays stable. Prefixes an animated
// spinner while the agent is running so activity is visible at a glance.
usePageTitle({ running, showAuthGate });

// Thinking is on/off (TUI parity — no effort-level cycling). The /thinking
// command flips between off and the backend default effort ('high').
function nextThinkingLevel(current: ThinkingLevel): ThinkingLevel {
  return current === 'off' ? 'high' : 'off';
}

// First-run onboarding (theme / language / welcome greeting). Shown until the
// user finishes it once; re-openable from the settings popover.
const showOnboarding = ref(!client.onboarded.value);
function completeOnboarding(): void {
  client.setOnboarded(true);
  showOnboarding.value = false;
}
function openOnboarding(): void {
  showOnboarding.value = true;
}

onMounted(() => {
  void client.load();
  loadSidebarCollapsed();
  // Capture-phase so Escape closes the side detail layer BEFORE the
  // conversation pane's bubble-phase handler interrupts a running prompt.
  document.addEventListener('keydown', onGlobalKeydown, true);
  offAuthRequired = onAuthRequired(() => {
    showServerAuth.value = true;
  });
});

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown, true);
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
  sideWidth,
  loadSidebarCollapsed,
  toggleSidebarCollapse,
} = useSidebarLayout({ previewOpen });

// ---------------------------------------------------------------------------
// Unified right-side detail layer (thinking / compaction / agent / diff / side
// chat) plus the preview-panel width. Only one detail is open at a time.
// ---------------------------------------------------------------------------
const {
  PREVIEW_WIDTH_KEY,
  PREVIEW_MIN,
  previewDefaultWidth,
  previewMax,
  previewWidth,
  previewPanelWidth,
  thinkingPanelText,
  thinkingVisible,
  openThinkingPanel,
  closeThinkingPanel,
  compactionPanelText,
  compactionPanelVisible,
  openCompactionPanel,
  closeCompactionPanel,
  agentPanelMember,
  openAgentPanel,
  closeAgentPanel,
  toolDiffTarget,
  openToolDiff,
  closeToolDiff,
  detailDiffMode,
  detailDiffPath,
  openDiffDetail,
  closeDiffDetail,
  selectDiffFile,
  btwVisible,
  openSideChatTab,
  closeSideChat,
  sidePanelVisible,
  panelDragging,
  closeOpenSidePanel,
} = useDetailPanel({ client, sideWidth, detailTarget, closeFilePreview });

// Reference to ConversationPane so we can imperatively switch tabs
const conversationPaneRef = ref<InstanceType<typeof ConversationPane> | null>(null);

// Shift-multi-selected workspace ids; when >1 are selected the main pane
// shows a "coming soon" placeholder instead of the conversation.
const selectedWorkspaceIds = ref<string[]>([]);
const hasMultiSelect = computed(() => selectedWorkspaceIds.value.length > 1);

function handleSelectWorkspaces(ids: string[]): void {
  selectedWorkspaceIds.value = ids;
}

// Dialog visibility refs
const showModelPicker = ref(false);
const showProviders = ref(false);
const showLogin = ref(false);
const showNewSession = ref(false);
const showSessions = ref(false);
const showAddWorkspace = ref(false);
const showStatusPanel = ref(false);
const showSettings = ref(false);

type SubmitPayload = {
  text: string;
  attachments: { fileId: string; kind: 'image' | 'video' }[];
};
const pendingWorkspaceSubmit = ref<SubmitPayload | null>(null);

// Any of these modal/overlay layers, when open, owns Escape. The global
// capture-phase handler must NOT close a background side panel out from under an
// open dialog — otherwise Escape dismisses the panel behind the dialog and the
// dialog's own Escape handler never fires. New top-level dialogs go here too.
const anyOverlayOpen = computed<boolean>(() =>
  showModelPicker.value ||
  showProviders.value ||
  showLogin.value ||
  showNewSession.value ||
  showSessions.value ||
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
    await client.refreshOAuthProviderModels();
    await client.loadModels();
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

async function handleSelectModel(modelId: string): Promise<void> {
  showModelPicker.value = false;
  await client.setModel(modelId);
}

async function handleAddProvider(input: { type: string; apiKey?: string; baseUrl?: string; defaultModel?: string }): Promise<void> {
  await client.addProvider(input);
}

async function handleDeleteProvider(id: string): Promise<void> {
  await client.deleteProvider(id);
}

async function handleRefreshProvider(id: string): Promise<void> {
  await client.refreshProvider(id);
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

// Edit + resend the last user message: undo the latest exchange on the daemon,
// then drop that message's text back into the composer for editing.
async function handleEditMessage(text: string): Promise<void> {
  await client.undo(1);
  await nextTick();
  conversationPaneRef.value?.loadComposerForEdit(text);
}

// Handler for slash commands emitted by Composer (via ConversationPane)
function handleCommand(cmd: string): void {
  // `/compact <text>` carries an optional free-text instruction steering what
  // the summary should focus on (TUI parity).
  if (cmd === '/compact' || cmd.startsWith('/compact ')) {
    client.compact(cmd.slice('/compact'.length).trim() || undefined);
    return;
  }
  // `/swarm` toggles swarm mode; `/swarm on|off` sets it; `/swarm <task>` enables
  // swarm and runs the task right away (TUI parity).
  if (cmd === '/swarm' || cmd.startsWith('/swarm ')) {
    const arg = cmd.slice('/swarm'.length).trim();
    if (arg === 'on') client.setSwarmMode(true);
    else if (arg === 'off') client.setSwarmMode(false);
    else if (arg) { client.setSwarmMode(true); void client.sendPrompt(arg); }
    else client.toggleSwarmMode();
    return;
  }
  // `/goal <objective>` creates a goal (and submits it); `/goal pause|resume|cancel`
  // controls the active one; bare `/goal` toggles goal mode for the next message.
  if (cmd === '/goal' || cmd.startsWith('/goal ')) {
    const arg = cmd.slice('/goal'.length).trim();
    if (arg === 'pause' || arg === 'resume' || arg === 'cancel') client.controlGoal(arg);
    else if (arg) void client.createGoal(arg);
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
      void openSideChatTab(arg || undefined);
    }
    return;
  }
  switch (cmd) {
    // `/new` and `/clear` are aliases: both open the onboarding composer (or
    // the new-session dialog when no workspace is active).
    case '/new':
    case '/clear':
      handleCreateSession();
      break;
    case '/sessions':
      showSessions.value = true;
      break;
    case '/fork':
      void client.forkSession();
      break;
    case '/undo':
      void client.undo();
      break;
    case '/permission': {
      // Cycle manual → auto → yolo → manual
      const current = client.permission.value;
      const next = current === 'manual' ? 'auto' : current === 'auto' ? 'yolo' : 'manual';
      client.setPermission(next);
      break;
    }
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
    case '/help':
      client.dismissWarning(-1);
      break;
    case '/status':
      showStatusPanel.value = true;
      break;
    case '/model':
      void openModelPicker();
      break;
    case '/provider':
      void openProviders();
      break;
    case '/login':
      openLogin();
      break;
    default: {
      // Not a built-in command → treat it as a session skill activation
      // (the user picked `/<skill>` from the menu, or typed `/<skill> args`).
      // The daemon answers an unknown name with skill.not_found, surfaced as a
      // warning, so a stray slash is harmless.
      const space = cmd.indexOf(' ');
      const name = (space === -1 ? cmd : cmd.slice(0, space)).slice(1);
      const args = space === -1 ? undefined : cmd.slice(space + 1).trim() || undefined;
      if (name) void client.activateSkill(name, args);
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

async function handleSubmit(payload: SubmitPayload): Promise<void> {
  const wsId = client.activeWorkspaceId.value;
  if (!client.activeSessionId.value && wsId) {
    await client.startSessionAndSendPrompt(wsId, payload.text, payload.attachments);
    return;
  }
  if (!client.activeSessionId.value && !wsId) {
    pendingWorkspaceSubmit.value = payload;
    showAddWorkspace.value = true;
    return;
  }
  void client.sendPrompt(payload.text, payload.attachments);
}

async function handleAddWorkspace(root: string): Promise<void> {
  showAddWorkspace.value = false;
  await client.addWorkspaceByPath(root);
  const pending = pendingWorkspaceSubmit.value;
  pendingWorkspaceSubmit.value = null;
  const wsId = client.activeWorkspaceId.value;
  if (pending && wsId) {
    await client.startSessionAndSendPrompt(wsId, pending.text, pending.attachments);
  }
}

function handleCloseAddWorkspace(): void {
  pendingWorkspaceSubmit.value = null;
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
    focusComposerAfterDraft();
  } else {
    showNewSession.value = true;
  }
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
    <section v-if="showAuthGate" class="auth-page">
      <div class="auth-page-inner">
        <svg ref="authLogoRef" class="auth-page-logo ch-logo" viewBox="0 0 32 22" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi Code" @mousedown.prevent @click="blinkAuthLogo">
          <defs>
            <mask id="authKimiEyes" maskUnits="userSpaceOnUse">
              <rect x="0" y="0" width="32" height="22" fill="#fff" />
              <g class="ch-eyes" fill="#000">
                <rect class="ch-eye" x="11.8" y="7" width="2.8" height="8" rx="1.4" />
                <rect class="ch-eye" x="17.4" y="7" width="2.8" height="8" rx="1.4" />
              </g>
            </mask>
          </defs>
          <rect x="1" y="1" width="30" height="20" rx="6" fill="var(--logo)" mask="url(#authKimiEyes)" />
        </svg>
        <div class="auth-page-copy">
          <h1>{{ t('app.authPageTitle') }}</h1>
          <p>{{ t('app.authPageMessage') }}</p>
        </div>
        <button type="button" class="auth-page-btn" @click="openLogin">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 3h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6" />
            <path d="M9 8H2" />
            <path d="M5 5l3 3-3 3" />
          </svg>
          <span>{{ t('app.authPageLogin') }}</span>
        </button>
      </div>
    </section>
    <div
      v-else
      class="app"
      :class="{ mobile: isMobile, 'sidebar-collapsed': sidebarCollapsed && !isMobile }"
      :style="{ '--side-w': sideWidth + 'px', '--preview-w': previewPanelWidth + 'px' }"
    >
    <!-- Desktop navigation: workspace rail + resizable session column. -->
    <template v-if="!isMobile">
      <Sidebar
        v-show="!sidebarCollapsed"
        :col-width="sideWidth"
        :active-workspace="client.visibleWorkspace.value"
        :active-workspace-id="client.activeWorkspaceId.value"
        :sessions="client.sessionsForView.value"
        :groups="client.workspaceGroups.value"
        :active-id="client.activeSessionId.value"
        :attention-by-session="client.attentionBySession.value"
        :pending-by-session="client.pendingBySession.value"
        :unread-by-session="client.unreadBySession.value"
        @select="client.selectSession($event)"
        @create="handleCreateSession"
        @create-in-workspace="handleCreateSessionInWorkspace($event)"
        @select-workspace="client.openWorkspace($event)"
        @add-workspace="showAddWorkspace = true"
        @rename="(id, title) => client.renameSession(id, title)"
        @archive="(id) => client.archiveSession(id)"
        @fork="(id) => client.forkSession(id)"
        @rename-workspace="(id, name) => client.renameWorkspace(id, name)"
        @delete-workspace="(id) => client.deleteWorkspace(id)"
        @reorder-workspaces="client.reorderWorkspaces($event)"
        @load-more-sessions="(id) => void client.loadMoreSessions(id)"
        @load-all-sessions="void client.loadAllSessions()"
        @select-workspaces="handleSelectWorkspaces"
        @open-settings="showSettings = true"
        @collapse="toggleSidebarCollapse"
      />
      <ResizeHandle
        v-show="!sidebarCollapsed"
        :storage-key="SIDEBAR_WIDTH_KEY"
        :default-width="SIDEBAR_DEFAULT"
        :min="SIDEBAR_MIN"
        :max="sidebarMax"
        @update:width="sessionColWidth = $event"
      />
      <div v-if="sidebarCollapsed" class="sidebar-rail">
        <button
          type="button"
          class="sidebar-expand-btn"
          :title="t('sidebar.expandSidebar')"
          :aria-label="t('sidebar.expandSidebar')"
          @click="toggleSidebarCollapse"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 6h9" />
            <path d="M4 12h9" />
            <path d="M4 18h9" />
            <path d="M17 9l3 3-3 3" />
          </svg>
        </button>
      </div>
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
      v-if="!hasMultiSelect"
      ref="conversationPaneRef"
      :mobile="isMobile"
      :modern="client.theme.value === 'modern' || client.theme.value === 'kimi'"
      :turns="client.turns.value"
      :session-id="client.activeSessionId.value"
      :approvals="client.pendingApprovals.value"
      :changes="client.changes.value"
      :git-info="client.gitInfo.value"
      :tasks="client.tasks.value"
      :todos="client.todos.value"
      :goal="client.goal.value"
      :swarms="client.swarms.value"
      :activation-badges="client.activationBadges.value"
      :status="client.status.value"
      :thinking="client.thinking.value"
      :plan-mode="client.planMode.value"
      :swarm-mode="client.swarmMode.value"
      :goal-mode="client.goalMode.value"
      :models="client.models.value"
      :starred-ids="client.starredModelIds.value"
      :skills="client.skills.value"
      :questions="client.questions.value"
      :running="running"
      :queued="client.queued.value"
      :search-files="client.searchFiles"
      :upload-image="client.uploadImage"
      :sending="client.isSending.value"
      :fast-moon="client.fastMoon.value"
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
      :beta-toc="client.betaToc.value"
      @open-changes="openDiffDetail()"
      @select-workspace="handleCreateSessionInWorkspace($event)"
      @add-workspace="showAddWorkspace = true"
      @open-pr="openPr"
      @submit="handleSubmit($event)"
      @steer="client.steerPrompt($event.text, $event.attachments)"
      @approval="(approvalId, response) => client.respondApproval(approvalId, response)"
      @cancel-task="client.cancelTask($event)"
      @answer="(questionId, response) => client.respondQuestion(questionId, response)"
      @dismiss="(questionId) => client.dismissQuestion(questionId)"
      @command="handleCommand"
      @interrupt="client.abortCurrentPrompt()"
      @unqueue="handleUnqueue"
      @edit-queued="handleEditQueued"
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
      @archive-session="(id) => client.archiveSession(id)"
      @compact="client.compact()"
      @pick-model="openModelPicker()"
      @select-model="client.setModel($event)"
      @open-file="openFilePreview($event)"
      @open-media="openMediaPreview($event)"
      @open-thinking="openThinkingPanel($event)"
      @open-compaction="openCompactionPanel($event)"
      @open-agent="openAgentPanel($event)"
      @open-tool-diff="openToolDiff($event)"
      @edit-message="handleEditMessage"
    />

    <!-- Multi-workspace selection placeholder -->
    <div v-else class="coming-soon">
      <span class="cs-icon">🚧</span>
      <span class="cs-text">{{ t('app.comingSoon') }}</span>
    </div>

    <ResizeHandle
      v-if="sidePanelVisible && !isMobile"
      :storage-key="PREVIEW_WIDTH_KEY"
      :default-width="previewDefaultWidth"
      :min="PREVIEW_MIN"
      :max="previewMax"
      reverse
      :aria-label="t('layout.resizePreviewAria')"
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
      class="global-preview"
      :class="{ open: sidePanelVisible, mobile: isMobile, 'no-anim': panelDragging }"
      role="complementary"
      :aria-label="t('layout.detailPanelAria')"
      :aria-hidden="!sidePanelVisible"
    >
      <ThinkingPanel
        v-if="detailTarget === 'thinking' && thinkingVisible"
        :text="thinkingPanelText ?? ''"
        @close="closeThinkingPanel"
      />
      <ThinkingPanel
        v-else-if="detailTarget === 'compaction' && compactionPanelVisible"
        :text="compactionPanelText ?? ''"
        :subtitle="t('conversation.summaryTitle')"
        @close="closeCompactionPanel"
      />
      <AgentDetailPanel
        v-else-if="detailTarget === 'agent' && agentPanelMember"
        :member="agentPanelMember"
        @close="closeAgentPanel"
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
        :selected-diff-path="client.selectedDiffPath.value"
        :file-diff-loading="client.fileDiffLoading.value"
        closable
        @open="selectDiffFile"
        @back="detailDiffMode = 'list'; detailDiffPath = null; client.clearFileDiff()"
        @close="closeDiffDetail"
      />
      <ToolDiffPanel
        v-else-if="detailTarget === 'toolDiff' && toolDiffTarget"
        :target="toolDiffTarget"
        @close="closeToolDiff"
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
    </aside>

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
      :theme="client.theme.value"
      :color-scheme="client.colorScheme.value"
      :ui-font-size="client.uiFontSize.value"
      :auth-ready="client.authReady.value"
      :account-model="client.defaultModel.value"
      :notify="client.notifyOnComplete.value"
      :notify-permission="client.notifyPermission.value"
      :beta-toc="client.betaToc.value"
      :config="client.config.value"
      :models="client.models.value"
      :config-saving="configSaving"
      :server-version="client.serverVersion.value"
      @set-theme="client.setTheme($event)"
      @set-color-scheme="client.setColorScheme($event)"
      @set-ui-font-size="client.setUiFontSize($event)"
      @set-notify="client.setNotifyOnComplete($event)"
      @set-beta-toc="client.setBetaToc($event)"
      @update-config="handleUpdateConfig($event)"
      @login="() => { showSettings = false; openLogin(); }"
      @logout="client.logout"
      @open-onboarding="() => { showSettings = false; openOnboarding(); }"
      @close="showSettings = false"
    />

    <!-- Provider Manager overlay -->
    <ProviderManager
      v-if="showProviders"
      :providers="client.providers.value"
      :loading="providersLoading"
      :unavailable="providersUnavailable"
      @add="handleAddProvider($event)"
      @refresh="handleRefreshProvider($event)"
      @delete="handleDeleteProvider($event)"
      @open-login="() => { showProviders = false; openLogin(); }"
      @close="showProviders = false"
    />

    <!-- New Session Dialog overlay (fallback cwd-typing path) -->
    <NewSessionDialog
      v-if="showNewSession"
      :recent-cwds="client.recentCwds.value"
      @create="({ cwd, title }) => { showNewSession = false; void client.createSession(cwd, { title }); }"
      @close="showNewSession = false"
    />

    <!-- Sessions browser overlay (/sessions) — client-side list, click to switch -->
    <SessionsDialog
      v-if="showSessions"
      :sessions="client.sessions.value"
      :workspace-groups="client.workspaceGroups.value"
      :attention-by-session="client.attentionBySession.value"
      :active-id="client.activeSessionId.value"
      @select="(id) => { void client.selectSession(id); showSessions = false; }"
      @close="showSessions = false"
    />

    <!-- Status panel overlay (/status) — renders current client state, no daemon call -->
    <StatusPanel
      v-if="showStatusPanel"
      :status="client.status.value"
      :thinking="client.thinking.value"
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
      @add="handleAddWorkspace($event)"
      @close="handleCloseAddWorkspace"
    />

    <!-- Global connecting splash on first load (until the daemon round-trips) -->
    <Transition name="gload-fade">
      <GlobalLoading v-if="!client.initialized.value" />
    </Transition>

    <!-- First-run onboarding overlay (theme / language / welcome greeting) -->
    <Onboarding
      v-if="showOnboarding && !showAuthGate"
      :theme="client.theme.value"
      @set-theme="client.setTheme($event)"
      @complete="completeOnboarding"
      @skip="completeOnboarding"
    />

    <!-- Floating warnings / agent errors (e.g. a 403 from the model provider) -->
    <WarningToasts :warnings="client.warnings.value" @dismiss="client.dismissWarning" />

    <!-- KAP/daemon debug panel (opt-in, ?debug=1) -->
    <DebugPanel v-if="debugEnabled" />

    <!-- Mobile switcher bottom-sheet: workspace groups + sessions (mirrors the
         desktop sidebar) -->
    <MobileSwitcherSheet
      v-if="isMobile"
      v-model="showMobileSwitcher"
      :groups="client.workspaceGroups.value"
      :active-workspace-id="client.activeWorkspaceId.value"
      :active-id="client.activeSessionId.value"
      :attention-by-session="client.attentionBySession.value"
      :attention-by-workspace="client.attentionByWorkspace.value"
      @select="client.selectSession($event)"
      @create="handleCreateSession"
      @create-in-workspace="handleCreateSessionInWorkspace($event)"
      @add-workspace="showAddWorkspace = true"
      @rename="(id, title) => client.renameSession(id, title)"
      @archive="(id) => client.archiveSession(id)"
      @delete-workspace="(id) => client.deleteWorkspace(id)"
      @load-more="(id) => void client.loadMoreSessions(id)"
    />

    <!-- Mobile settings bottom-sheet: session controls + app prefs + auth -->
    <MobileSettingsSheet
      v-if="isMobile"
      v-model="showMobileSettings"
      :status="client.status.value"
      :thinking="client.thinking.value"
      :plan-mode="client.planMode.value"
      :swarm-mode="client.swarmMode.value"
      :theme="client.theme.value"
      :color-scheme="client.colorScheme.value"
      :ui-font-size="client.uiFontSize.value"
      :auth-ready="client.authReady.value"
      :beta-toc="client.betaToc.value"
      :server-version="client.serverVersion.value"
      @pick-model="openModelPicker()"
      @set-thinking="client.setThinking($event)"
      @toggle-plan="client.togglePlanMode()"
      @toggle-swarm="client.toggleSwarmMode()"
      @set-permission="client.setPermission($event)"
      @set-theme="client.setTheme($event)"
      @set-color-scheme="client.setColorScheme($event)"
      @set-ui-font-size="client.setUiFontSize($event)"
      @set-beta-toc="client.setBetaToc($event)"
      @login="() => { showMobileSettings = false; openLogin(); }"
      @logout="client.logout"
    />
    </div>
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

.app-shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
}
.auth-page {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: var(--bg);
  color: var(--ink);
  box-sizing: border-box;
}
.auth-page-inner {
  width: min(420px, 100%);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 18px;
}
.auth-page-logo {
  width: 64px;
  height: 44px;
  flex: none;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition: transform 0.18s ease;
}
.auth-page-logo:hover {
  transform: scale(1.06);
}
.auth-page-copy {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.auth-page-copy h1 {
  margin: 0;
  font-family: var(--sans);
  font-size: 30px;
  line-height: 1.15;
  font-weight: 650;
  letter-spacing: 0;
  color: var(--ink);
}
.auth-page-copy p {
  margin: 0;
  font-family: var(--sans);
  font-size: var(--ui-font-size-lg);
  line-height: 1.55;
  color: var(--dim);
}
.auth-page-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 8px 14px;
  border: 1px solid var(--blue);
  border-radius: 8px;
  background: var(--blue);
  color: var(--bg);
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  cursor: pointer;
}
.auth-page-btn:hover {
  background: var(--blue2);
  border-color: var(--blue2);
}
.auth-page-btn:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
.app {
  --side-w: 248px;
  --preview-w: 460px;
  flex: 1;
  min-height: 0;
  display: grid;
  /* sidebar (rail + resizable session column) | 0-width handle | conversation.
     The 4px ResizeHandle overflows its zero-width track via negative margins so
     the whole strip is grabbable without consuming layout space. */
  /* The right-panel track is PERMANENT (auto = follows the aside's width, 0
     when closed) — opening animates the aside's width, so the conversation
     column is squeezed over smoothly instead of snapping to a new template. */
  grid-template-columns: var(--side-w) 0 minmax(0, 1fr) 0 auto;
  background: var(--bg);
  color: var(--ink);
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

/* Collapsed sidebar rail: keeps a slim, dedicated grid track so the expand
   button never overlaps the conversation header or squeezes the main pane. */
.sidebar-rail {
  grid-column: 1;
  display: flex;
  justify-content: center;
  padding-top: 8px;
  background: var(--panel);
  border-right: 1px solid var(--line);
}
.sidebar-expand-btn {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: none;
  border: none;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.sidebar-expand-btn:hover {
  background: var(--soft);
  color: var(--ink);
}
.sidebar-expand-btn:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}

/* The collapsed rail occupies track 1; keep the main pane pinned to the
   conversation track even though the sidebar/handle are display:none. */
.app.sidebar-collapsed > .con,
.app.sidebar-collapsed > .coming-soon {
  grid-column: 3;
}

/* Mobile single-column shell: slim top bar (auto) over the full-width
   conversation pane (1fr). No rail, no session column, no resize handle. */
.app.mobile {
  grid-template-columns: 1fr;
  grid-template-rows: auto 1fr;
}

/* The right-side panel column: a permanent grid item whose width animates
   0 ↔ var(--preview-w). The CONTENT keeps a fixed width (and carries the
   left hairline) so it clips during the transition instead of reflowing. */
.global-preview {
  grid-column: 5;
  min-width: 0;
  min-height: 0;
  width: 0;
  background: var(--bg);
  overflow: hidden;
  transition: width 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}
.global-preview.open {
  width: var(--preview-w);
}
/* While dragging the resize handle, follow the pointer 1:1. */
.global-preview.no-anim {
  transition: none;
}
.global-preview:not(.mobile) > * {
  width: var(--preview-w);
  height: 100%;
  box-sizing: border-box;
  border-left: 1px solid var(--line);
}
.global-preview.mobile {
  position: fixed;
  inset: 0;
  z-index: 80;
  width: auto;
  transition: none;
  border-top: 2px solid var(--ink);
}

/* Multi-workspace selection placeholder */
.coming-soon {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--muted);
  font-family: var(--mono);
}
/* Fixed icon glyph size — not part of the UI font scale. */
.cs-icon { font-size: 32px; }
.cs-text { font-size: var(--ui-font-size); }

@media (max-width: 640px) {
  .auth-page {
    align-items: flex-start;
    padding:
      max(48px, env(safe-area-inset-top))
      max(20px, env(safe-area-inset-right))
      max(24px, env(safe-area-inset-bottom))
      max(20px, env(safe-area-inset-left));
  }
  .auth-page-copy h1 {
    font-size: 26px;
  }
  .auth-page-btn {
    width: 100%;
    justify-content: center;
  }
}
</style>

<style>
:root {
  /* Right-side panel headers (ThinkingPanel / FilePreview / DiffView / SideChatPanel)
     share the same 48px height as the conversation header so the hairline reads as
     one continuous line across the layout. */
  --panel-head-h: 48px;
}
</style>
