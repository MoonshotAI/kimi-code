<!-- apps/kimi-web/src/App.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import Sidebar from './components/Sidebar.vue';
import ResizeHandle from './components/ResizeHandle.vue';
import ConversationPane from './components/ConversationPane.vue';
import FilePreview, { type FileData } from './components/FilePreview.vue';
import ThinkingPanel from './components/ThinkingPanel.vue';
import AgentDetailPanel from './components/AgentDetailPanel.vue';
import SideChatPanel from './components/SideChatPanel.vue';
import DiffView from './components/DiffView.vue';
import type { AgentMember } from './types';
import ModelPicker from './components/ModelPicker.vue';
import ProviderManager from './components/ProviderManager.vue';
import LoginDialog from './components/LoginDialog.vue';
import NewSessionDialog from './components/NewSessionDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import SessionsDialog from './components/SessionsDialog.vue';
import AddWorkspaceDialog from './components/AddWorkspaceDialog.vue';
import StatusPanel from './components/StatusPanel.vue';
import WarningToasts from './components/WarningToasts.vue';
import MobileTopBar from './components/MobileTopBar.vue';
import MobileSwitcherSheet from './components/MobileSwitcherSheet.vue';
import MobileSettingsSheet from './components/MobileSettingsSheet.vue';
import Onboarding from './components/Onboarding.vue';
import GlobalLoading from './components/GlobalLoading.vue';
import DebugPanel from './debug/DebugPanel.vue';
import { isTraceEnabled } from './debug/trace';
import { useKimiWebClient } from './composables/useKimiWebClient';
import { useIsMobile } from './composables/useIsMobile';
import type { AppConfig, ThinkingLevel } from './api/types';
import type { FilePreviewRequest, ToolMedia } from './types';

const client = useKimiWebClient();
provide('resolveImage', client.resolveImageUrl);
const { t } = useI18n();

// KAP/daemon debug panel — opt-in via ?debug=1 or localStorage kimi-web.debug=1.
const debugEnabled = isTraceEnabled();

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
  () => client.visibleWorkspace.value?.sessionCount ?? 0,
);

// running: true when activity is not idle
const running = computed(() => client.activity.value !== 'idle');


// Dynamic page title: session title first, then workspace name, then app name.
// Prefix an animated spinner when the agent is running so users can see activity
// at a glance.
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const spinnerFrame = ref(0);
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

function startSpinner(): void {
  if (spinnerTimer !== null) return;
  spinnerFrame.value = 0;
  spinnerTimer = setInterval(() => {
    spinnerFrame.value = (spinnerFrame.value + 1) % SPINNER_FRAMES.length;
  }, 250);
}

function stopSpinner(): void {
  if (spinnerTimer !== null) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  spinnerFrame.value = 0;
}

watch(running, (isRunning) => {
  if (isRunning) startSpinner();
  else stopSpinner();
}, { immediate: true });

const pageTitle = computed<string>(() => {
  const prefix = running.value ? `${SPINNER_FRAMES[spinnerFrame.value]} ` : '';
  const sessionTitle = activeSessionTitle.value;
  if (sessionTitle) return `${prefix}${sessionTitle} - Kimi Code Web`;
  const workspaceName = client.visibleWorkspace.value?.name;
  if (workspaceName) return `${prefix}${workspaceName} - Kimi Code Web`;
  return `${prefix}Kimi Code Web`;
});
watchEffect(() => {
  if (typeof document !== 'undefined') document.title = pageTitle.value;
});

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
});

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown, true);
  stopSpinner();
});

// Escape closes whichever transient right-side detail panel is open.
function closeOpenSidePanel(): boolean {
  if (detailTarget.value === 'thinking' && thinkingVisible.value) { closeThinkingPanel(); return true; }
  if (detailTarget.value === 'compaction' && compactionPanelVisible.value) { closeCompactionPanel(); return true; }
  if (detailTarget.value === 'agent' && agentPanelVisible.value) { closeAgentPanel(); return true; }
  if (detailTarget.value === 'file') { closeFilePreview(); return true; }
  if (detailTarget.value === 'diff') { closeDiffDetail(); return true; }
  if (detailTarget.value === 'btw') { closeSideChat(); return true; }
  return false;
}

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
// Layout: resizable session column. ResizeHandle owns the column width (with
// localStorage persistence); we mirror it here to drive the App grid.
// ---------------------------------------------------------------------------
const SIDEBAR_WIDTH_KEY = 'kimi-web.sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'kimi-web.sidebar-collapsed';
const SIDEBAR_DEFAULT = 270;
const SIDEBAR_MIN = 170;
const SIDEBAR_MAX = 420;
const SIDEBAR_COLLAPSED_WIDTH = 36;

const sessionColWidth = ref(SIDEBAR_DEFAULT);
const sidebarCollapsed = ref(false);
const sideWidth = computed(() =>
  sidebarCollapsed.value ? SIDEBAR_COLLAPSED_WIDTH : sessionColWidth.value,
);

function loadSidebarCollapsed(): void {
  try {
    sidebarCollapsed.value = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    sidebarCollapsed.value = false;
  }
}

function saveSidebarCollapsed(): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed.value));
  } catch {
    // ignore
  }
}

function toggleSidebarCollapse(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  saveSidebarCollapsed();
}

// ---------------------------------------------------------------------------
// Unified right-side detail layer. Only one detail is open at a time.
// ---------------------------------------------------------------------------
type DetailTarget = 'file' | 'diff' | 'thinking' | 'compaction' | 'agent' | 'btw';
const detailTarget = ref<DetailTarget | null>(null);

const PREVIEW_WIDTH_KEY = 'kimi-web.file-preview-width';
const PREVIEW_MIN = 320;

function previewAreaWidth(): number {
  if (typeof window === 'undefined') return PREVIEW_MIN * 2;
  return Math.max(0, window.innerWidth - sideWidth.value);
}

function clampPreviewWidth(width: number): number {
  const max = Math.max(PREVIEW_MIN, previewAreaWidth() - PREVIEW_MIN);
  return Math.min(max, Math.max(PREVIEW_MIN, Math.round(width)));
}

function defaultPreviewWidth(): number {
  return clampPreviewWidth(previewAreaWidth() / 2);
}

const previewDefaultWidth = computed(() => defaultPreviewWidth());
const previewMaxWidth = computed(() => Math.max(PREVIEW_MIN, previewAreaWidth() - PREVIEW_MIN));
const previewWidth = ref(previewDefaultWidth.value);
const previewTarget = ref<FilePreviewRequest | null>(null);
const previewFile = ref<FileData | null>(null);
const previewLoading = ref(false);
const previewError = ref<string | null>(null);
// Normalized workspace-relative path of the currently-open preview. Used for
// the download URL so it matches the server's relative-path contract even when
// the user opened the preview from an absolute path in the chat.
const previewNormalizedPath = ref<string | null>(null);
// Incremented on every openFilePreview call so a slower earlier request can't
// overwrite the result of a later one (request-sequence guard).
let previewRequestSeq = 0;

const previewDownloadUrl = computed(() => {
  const path = previewNormalizedPath.value;
  return path ? client.getFileDownloadUrl(path) : null;
});
const previewExternalActions = computed(() => previewTarget.value !== null);

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function normalizeRelativePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function normalizePreviewPath(inputPath: string): { path: string } | { error: string } {
  const raw = inputPath.trim();
  if (!raw) return { error: t('filePreview.errors.emptyPath') };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return { error: t('filePreview.errors.unsupportedPath') };
  }
  if (raw.startsWith('~')) {
    return { error: t('filePreview.errors.outsideWorkspace') };
  }

  const cwd = trimTrailingSlash(client.status.value.cwd);
  if (raw.startsWith('/')) {
    if (!cwd || (raw !== cwd && !raw.startsWith(`${cwd}/`))) {
      return { error: t('filePreview.errors.outsideWorkspace') };
    }
    const relative = raw === cwd ? '' : raw.slice(cwd.length + 1);
    if (relative.split(/[\\/]+/).includes('..')) {
      return { error: t('filePreview.errors.outsideWorkspace') };
    }
    const path = normalizeRelativePath(relative);
    return path ? { path } : { error: t('filePreview.errors.isDirectory') };
  }

  if (raw.split(/[\\/]+/).includes('..')) {
    return { error: t('filePreview.errors.outsideWorkspace') };
  }

  const path = normalizeRelativePath(raw);
  return path ? { path } : { error: t('filePreview.errors.emptyPath') };
}

async function openFilePreview(target: FilePreviewRequest): Promise<void> {
  const requestSeq = ++previewRequestSeq;
  detailTarget.value = 'file';
  previewFile.value = null;
  previewError.value = null;
  previewLoading.value = true;
  previewTarget.value = target;
  previewNormalizedPath.value = null;

  const normalized = normalizePreviewPath(target.path);
  if ('error' in normalized) {
    previewLoading.value = false;
    previewError.value = normalized.error;
    return;
  }
  previewNormalizedPath.value = normalized.path;

  try {
    const result = await client.readFileContent(normalized.path);
    // A newer openFilePreview started while this one was in flight — discard
    // the stale result so the right-side panel shows the latest file.
    if (requestSeq !== previewRequestSeq) return;
    if (result) {
      previewFile.value = { ...result, path: result.path || normalized.path };
    } else {
      previewFile.value = {
        path: normalized.path,
        content: '',
        encoding: 'utf-8',
        mime: 'text/plain',
        isBinary: false,
        size: 0,
      };
    }
  } catch (err) {
    if (requestSeq !== previewRequestSeq) return;
    previewError.value = err instanceof Error ? err.message : t('filePreview.errors.loadFailed');
  } finally {
    if (requestSeq === previewRequestSeq) {
      previewLoading.value = false;
    }
  }
}

function mimeFromDataUrl(url: string): string | undefined {
  const match = /^data:([^;,]+)/i.exec(url);
  return match?.[1];
}

function openMediaPreview(media: ToolMedia): void {
  if (media.kind !== 'image') return;
  detailTarget.value = 'file';
  previewTarget.value = null;
  previewNormalizedPath.value = null;
  previewError.value = null;
  previewLoading.value = false;
  previewFile.value = {
    path: media.path ?? 'ReadMediaFile image',
    content: '',
    encoding: 'utf-8',
    mime: media.mimeType ?? mimeFromDataUrl(media.url) ?? 'image/*',
    sourceUrl: media.url,
    isBinary: true,
    size: media.bytes ?? 0,
  };
}

function closeFilePreview(): void {
  previewTarget.value = null;
  previewNormalizedPath.value = null;
  previewFile.value = null;
  previewError.value = null;
  previewLoading.value = false;
  if (detailTarget.value === 'file') detailTarget.value = null;
}

// ---------------------------------------------------------------------------
// Thinking panel
// ---------------------------------------------------------------------------
const thinkingTarget = ref<{ turnId: string; blockIndex: number } | null>(null);

const thinkingPanelText = computed<string | null>(() => {
  const target = thinkingTarget.value;
  if (!target) return null;
  const turn = client.turns.value.find((tn) => tn.id === target.turnId);
  const blk = turn?.blocks?.[target.blockIndex];
  return blk?.kind === 'thinking' ? blk.thinking : null;
});

const thinkingVisible = computed(() => thinkingPanelText.value !== null);

function openThinkingPanel(target: { turnId: string; blockIndex: number }): void {
  const current = thinkingTarget.value;
  if (current && current.turnId === target.turnId && current.blockIndex === target.blockIndex) {
    thinkingTarget.value = null;
    if (detailTarget.value === 'thinking') detailTarget.value = null;
    return;
  }
  detailTarget.value = 'thinking';
  thinkingTarget.value = target;
}

function closeThinkingPanel(): void {
  thinkingTarget.value = null;
  if (detailTarget.value === 'thinking') detailTarget.value = null;
}

// ---------------------------------------------------------------------------
// Compaction summary panel
// ---------------------------------------------------------------------------
const compactionTarget = ref<{ turnId: string } | null>(null);

const compactionPanelText = computed<string | null>(() => {
  const target = compactionTarget.value;
  if (!target) return null;
  const turn = client.turns.value.find((tn) => tn.id === target.turnId);
  return turn?.role === 'compaction' && turn.text ? turn.text : null;
});

const compactionPanelVisible = computed(() => compactionPanelText.value !== null);

function openCompactionPanel(target: { turnId: string }): void {
  if (compactionTarget.value?.turnId === target.turnId) {
    compactionTarget.value = null;
    if (detailTarget.value === 'compaction') detailTarget.value = null;
    return;
  }
  detailTarget.value = 'compaction';
  compactionTarget.value = target;
}

function closeCompactionPanel(): void {
  compactionTarget.value = null;
  if (detailTarget.value === 'compaction') detailTarget.value = null;
}

// ---------------------------------------------------------------------------
// Subagent detail panel
// ---------------------------------------------------------------------------
const agentTarget = ref<{ turnId: string; blockIndex: number; memberId: string } | null>(null);

const agentPanelMember = computed<AgentMember | null>(() => {
  const target = agentTarget.value;
  if (!target) return null;
  const turn = client.turns.value.find((tn) => tn.id === target.turnId);
  const blk = turn?.blocks?.[target.blockIndex];
  if (!blk) return null;
  if (blk.kind === 'agent') return blk.member.id === target.memberId ? blk.member : null;
  if (blk.kind === 'agentGroup') return blk.members.find((m) => m.id === target.memberId) ?? null;
  return null;
});

const agentPanelVisible = computed(() => agentPanelMember.value !== null);

function openAgentPanel(target: { turnId: string; blockIndex: number; memberId: string }): void {
  const current = agentTarget.value;
  if (current && current.turnId === target.turnId && current.memberId === target.memberId) {
    agentTarget.value = null;
    if (detailTarget.value === 'agent') detailTarget.value = null;
    return;
  }
  detailTarget.value = 'agent';
  agentTarget.value = target;
}

function closeAgentPanel(): void {
  agentTarget.value = null;
  if (detailTarget.value === 'agent') detailTarget.value = null;
}

// ---------------------------------------------------------------------------
// Diff detail layer (opened from the chat header git area)
// ---------------------------------------------------------------------------
const detailDiffMode = ref<'list' | 'detail'>('list');
const detailDiffPath = ref<string | null>(null);

function openDiffDetail(): void {
  detailTarget.value = 'diff';
  detailDiffMode.value = 'list';
  detailDiffPath.value = null;
  void client.loadGitStatus(client.activeSessionId.value!);
}

function closeDiffDetail(): void {
  if (detailTarget.value === 'diff') detailTarget.value = null;
  detailDiffMode.value = 'list';
  detailDiffPath.value = null;
  client.clearFileDiff();
}

async function selectDiffFile(path: string): Promise<void> {
  detailDiffMode.value = 'detail';
  detailDiffPath.value = path;
  await client.loadFileDiff(path);
}

// ---------------------------------------------------------------------------
// Side chat (BTW) — now rendered in the unified right-side detail layer.
// ---------------------------------------------------------------------------
async function openSideChatTab(prompt?: string): Promise<void> {
  await client.openSideChat(prompt);
  detailTarget.value = 'btw';
}

function closeSideChat(): void {
  client.closeSideChat();
  if (detailTarget.value === 'btw') detailTarget.value = null;
}

// Only hides the right-side BTW panel; the side-chat target is per-session and
// preserved so switching back to a session restores its BTW transcript.
function hideSideChatPanel(): void {
  if (detailTarget.value === 'btw') detailTarget.value = null;
}

const btwVisible = computed(() => client.sideChatVisible.value);

/** Any occupant of the shared right-side slot. */
const sidePanelVisible = computed(
  () =>
    detailTarget.value !== null &&
    (detailTarget.value !== 'thinking' || thinkingVisible.value) &&
    (detailTarget.value !== 'compaction' || compactionPanelVisible.value) &&
    (detailTarget.value !== 'agent' || agentPanelVisible.value) &&
    (detailTarget.value !== 'btw' || btwVisible.value),
);

/** True while the panel's resize handle is being dragged — the width
    transition is disabled so the panel follows the pointer 1:1. */
const panelDragging = ref(false);

function openPreviewInEditor(): void {
  const path = previewFile.value?.path ?? previewTarget.value?.path;
  if (!path) return;
  void client.openWorkspaceFile(path, previewTarget.value?.line);
}

function revealPreviewFile(): void {
  const path = previewFile.value?.path ?? previewTarget.value?.path;
  if (!path) return;
  void client.revealWorkspaceFile(path);
}

watch(client.activeSessionId, () => {
  closeFilePreview();
  closeThinkingPanel();
  closeCompactionPanel();
  closeAgentPanel();
  closeDiffDetail();
  hideSideChatPanel();
});

// Reference to ConversationPane so we can imperatively switch tabs
const conversationPaneRef = ref<InstanceType<typeof ConversationPane> | null>(null);

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
const showSettings = ref(false);

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
      client.closeSideChat();
    } else {
      void openSideChatTab(arg || undefined);
    }
    return;
  }
  switch (cmd) {
    case '/new':
    case '/clear':
      showNewSession.value = true;
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

async function handleSubmit(payload: { text: string; attachments: { fileId: string; kind: 'image' | 'video' }[] }): Promise<void> {
  const wsId = client.activeWorkspaceId.value;
  if (!client.activeSessionId.value && wsId) {
    await client.startSessionAndSendPrompt(wsId, payload.text, payload.attachments);
    return;
  }
  void client.sendPrompt(payload.text, payload.attachments);
}

// Primary "+ New": enter the draft state in the current workspace so the
// right pane shows the onboarding composer. The session is only created when
// the user sends the first message.
function handleCreateSession(): void {
  const wsId = client.activeWorkspaceId.value;
  if (wsId) {
    client.openWorkspaceDraft(wsId);
  } else {
    showNewSession.value = true;
  }
}

// Workspace-level "+ New" (sidebar group or mobile switcher): enter the draft
// state in the chosen workspace. No backend session is created until the user
// actually sends a message.
function handleCreateSessionInWorkspace(workspaceId: string): void {
  client.openWorkspaceDraft(workspaceId);
}

// Chat header: open a GitHub PR in a new tab.
function openPr(url: string): void {
  if (url) window.open(url, '_blank', 'noopener');
}
</script>

<template>
  <div class="app-shell">
    <!-- Onboarding banner: shown when the daemon has no auth configured. It sits
         in the layout flow at the very top so it reserves height instead of
         overlapping the desktop ChatHeader / mobile top bar. -->
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
    <div
      class="app"
      :class="{ mobile: isMobile, 'sidebar-collapsed': sidebarCollapsed && !isMobile }"
      :style="{ '--side-w': sideWidth + 'px', '--preview-w': previewWidth + 'px' }"
    >
    <!-- Desktop navigation: workspace rail + resizable session column. -->
    <template v-if="!isMobile">
      <Sidebar
        v-show="!sidebarCollapsed"
        :col-width="sessionColWidth"
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
        @select-workspaces="handleSelectWorkspaces"
        @open-settings="showSettings = true"
        @collapse="toggleSidebarCollapse"
      />
      <ResizeHandle
        v-show="!sidebarCollapsed"
        :storage-key="SIDEBAR_WIDTH_KEY"
        :default-width="SIDEBAR_DEFAULT"
        :min="SIDEBAR_MIN"
        :max="SIDEBAR_MAX"
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
      :max="previewMaxWidth"
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
      @add="(root) => { showAddWorkspace = false; void client.addWorkspaceByPath(root); }"
      @close="showAddWorkspace = false"
    />

    <!-- Global connecting splash on first load (until the daemon round-trips) -->
    <Transition name="gload-fade">
      <GlobalLoading v-if="!client.initialized.value" />
    </Transition>

    <!-- First-run onboarding overlay (theme / language / welcome greeting) -->
    <Onboarding
      v-if="showOnboarding"
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
      @pick-model="openModelPicker()"
      @set-thinking="client.setThinking($event)"
      @toggle-plan="client.togglePlanMode()"
      @toggle-swarm="client.toggleSwarmMode()"
      @set-permission="client.setPermission($event)"
      @set-theme="client.setTheme($event)"
      @set-color-scheme="client.setColorScheme($event)"
      @set-ui-font-size="client.setUiFontSize($event)"
      @set-beta-toc="client.setBetaToc($event)"
      @login="openLogin"
      @logout="client.logout"
    />
    </div>
  </div>
</template>

<style scoped>
/* Global connecting splash fade-out (only the leave matters; it mounts instantly). */
.gload-fade-leave-active { transition: opacity 0.28s ease; }
.gload-fade-leave-to { opacity: 0; }

/* Outer shell: the auth banner (when shown) stacks above the app grid in normal
   flow so it reserves height instead of overlapping the header/top bar. */
.app-shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
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

/* Auth onboarding banner — in-flow at the top of the shell (full width, above
   both the desktop sidebar/header and the mobile top bar). */
.auth-banner {
  flex: none;
  background: var(--soft);
  border-bottom: 1px solid var(--bd);
}
.auth-banner-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
}
.auth-banner-icon { display: flex; align-items: center; flex: none; }
.auth-banner-msg { flex: 1; color: var(--text); }
.auth-banner-btn {
  background: var(--blue);
  border: none;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  padding: 4px 14px;
  color: var(--bg);
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
/* Fixed icon glyph size — not part of the UI font scale. */
.cs-icon { font-size: 32px; }
.cs-text { font-size: var(--ui-font-size); }

@media (max-width: 640px) {
  .auth-banner-inner {
    align-items: flex-start;
    flex-wrap: wrap;
    padding:
      8px
      max(12px, env(safe-area-inset-right))
      8px
      max(12px, env(safe-area-inset-left));
  }
  .auth-banner-msg {
    min-width: 0;
    flex: 1 1 calc(100% - 34px);
    line-height: 1.45;
  }
  .auth-banner-btn {
    margin-left: 24px;
    max-width: calc(100% - 24px);
    white-space: normal;
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
