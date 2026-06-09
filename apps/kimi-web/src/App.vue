<!-- apps/kimi-web/src/App.vue -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Sidebar from './components/Sidebar.vue';
import ResizeHandle from './components/ResizeHandle.vue';
import ConversationPane from './components/ConversationPane.vue';
import ModelPicker from './components/ModelPicker.vue';
import ProviderManager from './components/ProviderManager.vue';
import LoginDialog from './components/LoginDialog.vue';
import NewSessionDialog from './components/NewSessionDialog.vue';
import SessionsDialog from './components/SessionsDialog.vue';
import AddWorkspaceDialog from './components/AddWorkspaceDialog.vue';
import StatusPanel from './components/StatusPanel.vue';
import WarningToasts from './components/WarningToasts.vue';
import MobileTopBar from './components/MobileTopBar.vue';
import MobileSwitcherSheet from './components/MobileSwitcherSheet.vue';
import MobileSettingsSheet from './components/MobileSettingsSheet.vue';
import { useKimiWebClient } from './composables/useKimiWebClient';
import { useIsMobile } from './composables/useIsMobile';
import type { ThinkingLevel } from './api/types';

const client = useKimiWebClient();
const { t } = useI18n();

// Narrow viewports (≤640px) render the single-column mobile shell; desktop is
// unchanged. jsdom defaults to false (desktop) so component tests are unaffected.
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
  () => client.sessionsForView.value.length,
);

// Cycle through thinking levels for the /thinking slash command (no popover
// anchor when invoked from the composer).
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
function nextThinkingLevel(current: ThinkingLevel): ThinkingLevel {
  const idx = THINKING_LEVELS.indexOf(current);
  return THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length]!;
}

onMounted(() => {
  void client.load();
});

// ---------------------------------------------------------------------------
// Layout: resizable session column. The left grid cell = fixed rail (52px) +
// the user-resizable session column. ResizeHandle owns the column width (with
// localStorage persistence); we mirror it here to drive the App grid.
// ---------------------------------------------------------------------------
const RAIL_WIDTH = 52;
const RAIL_EXPANDED_WIDTH = 190;
const RAIL_EXPANDED_KEY = 'kimi-web.rail-expanded';
const SIDEBAR_WIDTH_KEY = 'kimi-web.sidebar-width';
const SIDEBAR_DEFAULT = 196;
const SIDEBAR_MIN = 170;
const SIDEBAR_MAX = 420;

// Rail mode: collapsed (52px icon rail, default) vs expanded (named rows).
// Restored from localStorage on load; the toggle persists each flip.
function readRailExpanded(): boolean {
  try {
    return localStorage.getItem(RAIL_EXPANDED_KEY) === 'true';
  } catch {
    return false;
  }
}
const railExpanded = ref(readRailExpanded());
const railWidth = computed(() => (railExpanded.value ? RAIL_EXPANDED_WIDTH : RAIL_WIDTH));

function toggleRailExpand(): void {
  railExpanded.value = !railExpanded.value;
  try {
    localStorage.setItem(RAIL_EXPANDED_KEY, String(railExpanded.value));
  } catch {
    // localStorage unavailable (e.g. private mode) — mode still works in-memory
  }
}

const sessionColWidth = ref(SIDEBAR_DEFAULT);
const sideWidth = computed(() => railWidth.value + sessionColWidth.value);

// Reference to ConversationPane so we can imperatively switch tabs
const conversationPaneRef = ref<InstanceType<typeof ConversationPane> | null>(null);

// running: true when activity is not idle
const running = computed(() => client.activity.value !== 'idle');

// Auth readiness — drives onboarding banner
const authReady = computed(() => client.authReady.value);

// Dialog visibility refs
const showModelPicker = ref(false);
const showProviders = ref(false);
const showLogin = ref(false);
const showNewSession = ref(false);
const showSessions = ref(false);
const showAddWorkspace = ref(false);
const showStatusPanel = ref(false);

// Loading state for model/provider fetches
const modelsLoading = ref(false);
const modelsUnavailable = ref(false);
const providersLoading = ref(false);
const providersUnavailable = ref(false);

async function openModelPicker(): Promise<void> {
  modelsLoading.value = true;
  modelsUnavailable.value = false;
  showModelPicker.value = true;
  try {
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

// Handler for slash commands emitted by Composer (via ConversationPane)
function handleCommand(cmd: string): void {
  switch (cmd) {
    case '/new':
    case '/clear':
      showNewSession.value = true;
      break;
    case '/sessions':
      showSessions.value = true;
      break;
    case '/compact':
      client.compact();
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
    case '/tasks':
      conversationPaneRef.value?.switchTab('tasks');
      break;
    case '/help':
      client.dismissWarning(-1);
      break;
    case '/status':
      showStatusPanel.value = true;
      break;
    case '/undo':
      client.undo();
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
    default:
      break;
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

function handleSubmit(payload: { text: string; attachments: { fileId: string }[] }): void {
  void client.sendPrompt(payload.text, payload.attachments);
}

// Primary "+ New": one-click session in the active workspace. If there is no
// active workspace yet (no sessions / no folder added), fall back to the cwd
// dialog so the user can still start somewhere.
function handleCreateSession(): void {
  const wsId = client.activeWorkspaceId.value;
  if (wsId) {
    void client.createSessionInWorkspace(wsId);
  } else {
    showNewSession.value = true;
  }
}
</script>

<template>
  <div class="app" :class="{ mobile: isMobile }" :style="{ '--side-w': sideWidth + 'px' }">
    <!-- Desktop navigation: workspace rail + resizable session column. -->
    <template v-if="!isMobile">
      <Sidebar
        :col-width="sessionColWidth"
        :rail-expanded="railExpanded"
        :workspaces="client.workspacesView.value"
        :active-workspace="client.visibleWorkspace.value"
        :active-workspace-id="client.activeWorkspaceId.value"
        :scope="client.workspaceScope.value"
        :sessions="client.sessionsForView.value"
        :groups="client.workspaceGroups.value"
        :active-id="client.activeSessionId.value"
        :attention-by-session="client.attentionBySession.value"
        :attention-by-workspace="client.attentionByWorkspace.value"
        :auth-ready="client.authReady.value"
        :account-model="client.defaultModel.value"
        :theme="client.theme.value"
        @select="client.selectSession($event)"
        @create="handleCreateSession"
        @create-in-workspace="client.createSessionInWorkspace($event)"
        @select-workspace="client.selectWorkspace($event)"
        @set-scope="client.setWorkspaceScope($event)"
        @add-workspace="showAddWorkspace = true"
        @rename="(id, title) => client.renameSession(id, title)"
        @delete="(id) => client.deleteSession(id)"
        @login="openLogin"
        @logout="client.logout"
        @toggle-rail-expand="toggleRailExpand"
        @set-theme="client.setTheme($event)"
      />
      <ResizeHandle
        :storage-key="SIDEBAR_WIDTH_KEY"
        :default-width="SIDEBAR_DEFAULT"
        :min="SIDEBAR_MIN"
        :max="SIDEBAR_MAX"
        @update:width="sessionColWidth = $event"
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
      :modern="client.theme.value === 'modern'"
      :turns="client.turns.value"
      :approvals="client.pendingApprovals.value"
      :changes="client.changes.value"
      :git-info="client.gitInfo.value"
      :file-diff="client.fileDiff.value"
      :selected-diff-path="client.selectedDiffPath.value"
      :file-diff-loading="client.fileDiffLoading.value"
      :load-file-diff="client.loadFileDiff"
      :clear-file-diff="client.clearFileDiff"
      :tasks="client.tasks.value"
      :status="client.status.value"
      :thinking="client.thinking.value"
      :plan-mode="client.planMode.value"
      :questions="client.questions.value"
      :running="running"
      :queued="client.queued.value"
      :search-files="client.searchFiles"
      :upload-image="client.uploadImage"
      :connection="client.connection.value"
      :activity="client.activity.value"
      :load-dir="client.listDir"
      :read-file="client.readFileContent"
      :changes-by-path="client.changesByPath.value"
      :file-reload-key="client.activeSessionId.value"
      @submit="handleSubmit($event)"
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
      @compact="client.compact()"
      @pick-model="openModelPicker()"
    />

    <!-- Model Picker overlay -->
    <ModelPicker
      v-if="showModelPicker"
      :models="client.models.value"
      :current="client.status.value.model"
      :loading="modelsLoading"
      :unavailable="modelsUnavailable"
      @select="handleSelectModel($event)"
      @close="showModelPicker = false"
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

    <!-- Login Dialog overlay -->
    <LoginDialog
      v-if="showLogin"
      :on-start-o-auth-login="handleStartOAuthLogin"
      :on-poll-o-auth-login="handlePollOAuthLogin"
      :on-cancel-o-auth-login="handleCancelOAuthLogin"
      @success="handleLoginSuccess"
      @close="showLogin = false"
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
      :cost-usd="client.sessionCost.value"
      @close="showStatusPanel = false"
    />

    <!-- Add Workspace overlay (daemon folder browser + paste-path fallback) -->
    <AddWorkspaceDialog
      v-if="showAddWorkspace"
      :recent-roots="client.recentRoots.value"
      :browse-fs="client.browseFs"
      :get-fs-home="client.getFsHome"
      @add="(root) => { showAddWorkspace = false; void client.addWorkspaceByPath(root); }"
      @close="showAddWorkspace = false"
    />

    <!-- Onboarding banner: shown when daemon has no auth configured -->
    <div v-if="!authReady" class="auth-banner">
      <div class="auth-banner-inner">
        <div class="auth-banner-icon">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--blue)" stroke-width="1.5">
            <circle cx="10" cy="10" r="8"/>
            <line x1="10" y1="6" x2="10" y2="10"/>
            <circle cx="10" cy="13" r="1" fill="var(--blue)"/>
          </svg>
        </div>
        <span class="auth-banner-msg">{{ t('app.authBannerMessage') }}</span>
        <button class="auth-banner-btn" @click="openLogin">{{ t('app.authBannerLogin') }}</button>
      </div>
    </div>

    <!-- Floating warnings / agent errors (e.g. a 403 from the model provider) -->
    <WarningToasts :warnings="client.warnings.value" @dismiss="client.dismissWarning" />

    <!-- Mobile switcher bottom-sheet: workspaces + sessions + new/add -->
    <MobileSwitcherSheet
      v-if="isMobile"
      v-model="showMobileSwitcher"
      :workspaces="client.workspacesView.value"
      :active-workspace="client.visibleWorkspace.value"
      :active-workspace-id="client.activeWorkspaceId.value"
      :sessions="client.sessionsForView.value"
      :active-id="client.activeSessionId.value"
      :attention-by-session="client.attentionBySession.value"
      :attention-by-workspace="client.attentionByWorkspace.value"
      @select="client.selectSession($event)"
      @select-workspace="client.selectWorkspace($event)"
      @create="handleCreateSession"
      @add-workspace="showAddWorkspace = true"
      @rename="(id, title) => client.renameSession(id, title)"
      @delete="(id) => client.deleteSession(id)"
    />

    <!-- Mobile session-settings bottom-sheet: the StatusLine controls -->
    <MobileSettingsSheet
      v-if="isMobile"
      v-model="showMobileSettings"
      :status="client.status.value"
      :thinking="client.thinking.value"
      :plan-mode="client.planMode.value"
      @pick-model="openModelPicker()"
      @set-thinking="client.setThinking($event)"
      @toggle-plan="client.togglePlanMode()"
      @set-permission="client.setPermission($event)"
    />
  </div>
</template>

<style scoped>
.app {
  --side-w: 248px;
  height: 100vh;
  display: grid;
  /* sidebar (rail + resizable session column) | 0-width handle | conversation.
     The 4px ResizeHandle overflows its zero-width track via negative margins so
     the whole strip is grabbable without consuming layout space. */
  grid-template-columns: var(--side-w) 0 1fr;
  background: var(--bg);
  color: var(--ink);
  border-top: 2px solid var(--ink);
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

/* Mobile single-column shell: slim top bar (auto) over the full-width
   conversation pane (1fr). No rail, no session column, no resize handle. */
.app.mobile {
  grid-template-columns: 1fr;
  grid-template-rows: auto 1fr;
}

/* Auth onboarding banner */
.auth-banner {
  position: fixed;
  top: 0;
  left: var(--side-w); /* sidebar width (52 rail + resizable session column) */
  right: 0;
  z-index: 50;
  background: var(--soft);
  border-bottom: 1px solid var(--bd);
}
/* Mobile: the banner spans the full width (no sidebar to clear). */
.app.mobile .auth-banner { left: 0; }
.auth-banner-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  font-family: var(--mono);
  font-size: 12px;
}
.auth-banner-icon { display: flex; align-items: center; flex: none; }
.auth-banner-msg { flex: 1; color: var(--text); }
.auth-banner-btn {
  background: var(--blue);
  border: none;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 12px;
  padding: 4px 14px;
  color: #fff;
  cursor: pointer;
  flex: none;
}
.auth-banner-btn:hover { background: var(--blue2); }
</style>
