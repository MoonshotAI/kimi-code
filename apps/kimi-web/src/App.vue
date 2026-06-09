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
import Onboarding from './components/Onboarding.vue';
import GlobalLoading from './components/GlobalLoading.vue';
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
});

// ---------------------------------------------------------------------------
// Layout: resizable session column. ResizeHandle owns the column width (with
// localStorage persistence); we mirror it here to drive the App grid.
// ---------------------------------------------------------------------------
const SIDEBAR_WIDTH_KEY = 'kimi-web.sidebar-width';
const SIDEBAR_DEFAULT = 196;
const SIDEBAR_MIN = 170;
const SIDEBAR_MAX = 420;

const sessionColWidth = ref(SIDEBAR_DEFAULT);
const sideWidth = computed(() => sessionColWidth.value);

// Reference to ConversationPane so we can imperatively switch tabs
const conversationPaneRef = ref<InstanceType<typeof ConversationPane> | null>(null);

// running: true when activity is not idle
const running = computed(() => client.activity.value !== 'idle');

// Auth readiness — drives onboarding banner
const authReady = computed(() => client.authReady.value);

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
    case '/fork':
      void client.forkSession();
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
        :active-workspace="client.visibleWorkspace.value"
        :active-workspace-id="client.activeWorkspaceId.value"
        :sessions="client.sessionsForView.value"
        :groups="client.workspaceGroups.value"
        :active-id="client.activeSessionId.value"
        :attention-by-session="client.attentionBySession.value"
        :auth-ready="client.authReady.value"
        :account-model="client.defaultModel.value"
        :theme="client.theme.value"
        :code-font="client.codeFont.value"
        :accent="client.accent.value"
        @select="client.selectSession($event)"
        @create="handleCreateSession"
        @create-in-workspace="client.createSessionInWorkspace($event)"
        @select-workspace="client.selectWorkspace($event)"
        @add-workspace="showAddWorkspace = true"
        @rename="(id, title) => client.renameSession(id, title)"
        @delete="(id) => client.deleteSession(id)"
        @rename-workspace="(id, name) => client.renameWorkspace(id, name)"
        @select-workspaces="handleSelectWorkspaces"
        @login="openLogin"
        @logout="client.logout"
        @set-theme="client.setTheme($event)"
        @set-code-font="client.setCodeFont($event)"
        @set-accent="client.setAccent($event)"
        @open-onboarding="openOnboarding"
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
      v-if="!hasMultiSelect"
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
      :models="client.models.value"
      :questions="client.questions.value"
      :running="running"
      :queued="client.queued.value"
      :search-files="client.searchFiles"
      :upload-image="client.uploadImage"
      :connection="client.connection.value"
      :activity="client.activity.value"
      :sending="client.isSending.value"
      :load-dir="client.listDir"
      :read-file="client.readFileContent"
      :changes-by-path="client.changesByPath.value"
      :file-reload-key="client.activeSessionId.value"
      :session-loading="client.sessionLoading.value"
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
      @select-model="client.setModel($event)"
    />

    <!-- Multi-workspace selection placeholder -->
    <div v-else class="coming-soon">
      <span class="cs-icon">🚧</span>
      <span class="cs-text">{{ t('app.comingSoon') }}</span>
    </div>

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

    <!-- Global connecting splash on first load (until the daemon round-trips) -->
    <Transition name="gload-fade">
      <GlobalLoading v-if="!client.initialized.value" />
    </Transition>

    <!-- First-run onboarding overlay (theme / language / welcome greeting) -->
    <Onboarding
      v-if="showOnboarding"
      :theme="client.theme.value"
      :accent="client.accent.value"
      @set-theme="client.setTheme($event)"
      @set-accent="client.setAccent($event)"
      @complete="completeOnboarding"
      @skip="completeOnboarding"
    />

    <!-- Floating warnings / agent errors (e.g. a 403 from the model provider) -->
    <WarningToasts :warnings="client.warnings.value" @dismiss="client.dismissWarning" />

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
      @create-in-workspace="client.createSessionInWorkspace($event)"
      @add-workspace="showAddWorkspace = true"
      @rename="(id, title) => client.renameSession(id, title)"
      @delete="(id) => client.deleteSession(id)"
    />

    <!-- Mobile settings bottom-sheet: session controls + app prefs + auth -->
    <MobileSettingsSheet
      v-if="isMobile"
      v-model="showMobileSettings"
      :status="client.status.value"
      :thinking="client.thinking.value"
      :plan-mode="client.planMode.value"
      :theme="client.theme.value"
      :accent="client.accent.value"
      :auth-ready="client.authReady.value"
      @pick-model="openModelPicker()"
      @set-thinking="client.setThinking($event)"
      @toggle-plan="client.togglePlanMode()"
      @set-permission="client.setPermission($event)"
      @set-theme="client.setTheme($event)"
      @set-accent="client.setAccent($event)"
      @login="openLogin"
      @logout="client.logout"
    />
  </div>
</template>

<style scoped>
/* Global connecting splash fade-out (only the leave matters; it mounts instantly). */
.gload-fade-leave-active { transition: opacity 0.28s ease; }
.gload-fade-leave-to { opacity: 0; }

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
  font-size: 14px;
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
.cs-icon { font-size: 32px; }
.cs-text { font-size: 14px; }
</style>
