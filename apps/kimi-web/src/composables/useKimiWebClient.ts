// apps/kimi-web/src/composables/useKimiWebClient.ts
// Vue state composable — the only place that imports both src/api/* and src/types.ts.
// Components consume computed view props and call actions; they never touch the API or reducer.

import { computed, reactive, ref, watch } from 'vue';
import { i18n } from '../i18n';
import { getKimiWebApi } from '../api';
import { isDaemonApiError, isDaemonNetworkError } from '../api/errors';
import { safeGetString, safeRemove, safeSetString, STORAGE_KEYS } from '../lib/storage';
import { useAppearance } from './client/useAppearance';
import { useNotification } from './client/useNotification';

const appearance = useAppearance();
const notification = useNotification();
import type {
  AppApprovalRequest,
  AppConfig,
  AppGoal,
  AppNotice,
  AppNoticeDetail,
  AppMessage,
  AppModel,
  AppProvider,
  AppQuestionRequest,
  AppSession,
  AppSessionRuntimeStatus,
  AppSkill,
  AppTask,
  AppWarning,
  AppWorkspace,
  ApprovalDecision,
  ApprovalResponse,
  FsEntry,
  KimiEventConnection,
  QuestionResponse,
  ThinkingLevel,
} from '../api/types';
import { createInitialState, reduceAppEvent, type CompactionStatus, type KimiClientState } from '../api/daemon/eventReducer';
import { readSessionIdFromLocation, sessionUrl } from '../lib/sessionRoute';
import type { SessionUrlMode } from '../lib/sessionRoute';
import { toAppEvent } from '../api/daemon/mappers';
import { parseDiff } from '../lib/parseDiff';
import { coerceThinkingForModel } from '../lib/modelThinking';
import { keepLiveSubagents } from '../lib/taskMerge';
import { messagesToTurns } from './messagesToTurns';
import { latestTodos } from './latestTodos';
import { buildSwarmGroups, countSwarmMembers } from './swarmGroups';
import type { SwarmGroup } from './swarmGroups';
import type {
  ActivityState,
  ActivationBadges,
  ApprovalBlock,
  ChatTurn,
  ConnectionState,
  ConversationStatus,
  DiffLine,
  DiffViewLine,
  PermissionMode,
  QueuedPromptView,
  Session,
  TaskItem,
  TaskState,
  TodoView,
  UIQuestion,
  Workspace,
  WorkspaceGroup,
  WorkspaceView,
} from '../types';

// ---------------------------------------------------------------------------
// Internal reactive state (plain object wrapped in reactive())
// ---------------------------------------------------------------------------

const PERMISSION_STORAGE_KEY = STORAGE_KEYS.permission;
const ACTIVE_WORKSPACE_KEY = STORAGE_KEYS.activeWorkspace;
const THINKING_STORAGE_KEY = STORAGE_KEYS.thinking;
const PLAN_MODE_STORAGE_KEY = STORAGE_KEYS.planMode;
const SWARM_MODE_STORAGE_KEY = STORAGE_KEYS.swarmMode;
const GOAL_MODE_STORAGE_KEY = STORAGE_KEYS.goalMode;
const STARRED_MODELS_STORAGE_KEY = STORAGE_KEYS.starredModels;
const UNREAD_STORAGE_KEY = STORAGE_KEYS.unread;
const SESSION_NOT_FOUND_CODE = 40401;
const PROMPT_NOT_FOUND_CODE = 40402;
const ONBOARDED_STORAGE_KEY = STORAGE_KEYS.onboarded;
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

// Appearance types + logic live in ./client/useAppearance; re-exported here so
// existing `import type { Theme, ColorScheme, Accent } from './useKimiWebClient'`
// callers keep working.
export type { Accent, ColorScheme, Theme } from './client/useAppearance';

// The code-font setting was removed with its UI (b8a9e83). Clear the old
// persisted key so users who once picked a font aren't frozen on it forever.
safeRemove(STORAGE_KEYS.codeFont);

function loadPermissionFromStorage(): PermissionMode {
  try {
    const v = safeGetString(PERMISSION_STORAGE_KEY);
    if (v === 'auto' || v === 'yolo' || v === 'manual') return v;
  } catch {
    // localStorage not available (e.g. jsdom without config)
  }
  return 'manual';
}

function savePermissionToStorage(mode: PermissionMode): void {
  try {
    safeSetString(PERMISSION_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

function loadThinkingFromStorage(): ThinkingLevel {
  try {
    const v = safeGetString(THINKING_STORAGE_KEY);
    if (v && (THINKING_LEVELS as readonly string[]).includes(v)) return v as ThinkingLevel;
  } catch {
    // ignore
  }
  return 'high';
}

function saveThinkingToStorage(v: ThinkingLevel): void {
  try {
    safeSetString(THINKING_STORAGE_KEY, v);
  } catch {
    // ignore
  }
}

function loadPlanModeFromStorage(): boolean {
  try {
    return safeGetString(PLAN_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function savePlanModeToStorage(v: boolean): void {
  try {
    safeSetString(PLAN_MODE_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}

function loadSwarmModeFromStorage(): boolean {
  try {
    return safeGetString(SWARM_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveSwarmModeToStorage(v: boolean): void {
  try {
    safeSetString(SWARM_MODE_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}

function loadGoalModeFromStorage(): boolean {
  try {
    return safeGetString(GOAL_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveGoalModeToStorage(v: boolean): void {
  try {
    safeSetString(GOAL_MODE_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}

// Per-session unread flags are pure client state (set when a background turn
// finishes, cleared on open). Persisting the `true` entries lets them survive a
// page refresh — without this the sidebar's unread dots vanish on reload because
// the in-memory map starts empty and there is no server-side read cursor.
function loadUnreadFromStorage(): Record<string, boolean> {
  try {
    const raw = safeGetString(UNREAD_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[id] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function saveUnreadToStorage(map: Record<string, boolean>): void {
  try {
    // Store only the `true` entries so the key stays compact (cleared sessions
    // write `false` and are dropped here).
    const out: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(map)) {
      if (value) out[id] = true;
    }
    safeSetString(UNREAD_STORAGE_KEY, JSON.stringify(out));
  } catch {
    // ignore
  }
}

function loadStarredModelsFromStorage(): string[] {
  try {
    const raw = safeGetString(STARRED_MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed as string[];
    }
  } catch {
    // ignore (localStorage not available or malformed)
  }
  return [];
}

function saveStarredModelsToStorage(v: string[]): void {
  try {
    safeSetString(STARRED_MODELS_STORAGE_KEY, JSON.stringify(v));
  } catch {
    // ignore
  }
}

function loadActiveWorkspaceFromStorage(): string | null {
  try {
    return safeGetString(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

// Roots the user removed from the sidebar. "Remove workspace" must hide a
// workspace even when it still has sessions (the daemon DELETE is registry-only
// and mergedWorkspaces would otherwise re-derive it from those sessions' cwds).
// History is untouched — only the sidebar entry is hidden — so this is persisted
// per browser, keyed by root path.
const HIDDEN_WORKSPACES_KEY = STORAGE_KEYS.hiddenWorkspaces;

function loadHiddenWorkspacesFromStorage(): string[] {
  try {
    const v = safeGetString(HIDDEN_WORKSPACES_KEY);
    if (!v) return [];
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveHiddenWorkspacesToStorage(roots: string[]): void {
  try {
    safeSetString(HIDDEN_WORKSPACES_KEY, JSON.stringify(roots));
  } catch {
    // ignore
  }
}

function saveActiveWorkspaceToStorage(id: string): void {
  try {
    safeSetString(ACTIVE_WORKSPACE_KEY, id);
  } catch {
    // ignore
  }
}

/** basename of an absolute path (last non-empty segment), defaulting to the path. */
function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

/** Shorten a $HOME-prefixed absolute path to `~/…` for dim display. */
function shortenHome(path: string, home: string | null): string {
  if (home && path.startsWith(home)) {
    const rest = path.slice(home.length);
    return rest ? `~${rest}` : '~';
  }
  // Heuristic when we don't know $HOME: collapse /Users/<x> or /home/<x>.
  const m = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (m) return `~${m[1] ?? ''}`;
  return path;
}

interface GitStatusEntry {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
  additions: number;
  deletions: number;
  pullRequest: { number: number; state: string; url: string } | null;
}

/** An uploaded attachment to send with a prompt. `kind` drives the content-block
    type (image vs video) so a still and a clip resolve to the right wire shape. */
type PromptAttachment = { fileId: string; kind: 'image' | 'video' };

/** A prompt waiting for the session to go idle. Keeps the uploaded
    fileIds so attachments survive queueing (not just the text). */
interface QueuedPrompt {
  text: string;
  attachments?: PromptAttachment[];
}

interface ExtendedState extends KimiClientState {
  connected: boolean;
  serverVersion: string;
  workspaceName: string;
  connection: ConnectionState;
  permission: PermissionMode;
  thinking: ThinkingLevel;
  planMode: boolean;
  swarmMode: boolean;
  goalMode: boolean;
  loading: boolean;
  sessionLoading: boolean;
  queuedBySession: Record<string, QueuedPrompt[]>;
  gitStatusBySession: Record<string, GitStatusEntry>;
  // Real daemon prompt_id of the last submitted prompt, per session. This is the
  // AUTHORITATIVE id for :abort — the event projector synthesizes a `pr_…` id
  // when turn.started races ahead of binding, which the daemon rejects.
  promptIdBySession: Record<string, string>;
  // True while a prompt is in flight but the assistant reply hasn't started yet.
  sendingBySession: Record<string, boolean>;
  // True when a BACKGROUND session finished a turn the user hasn't opened since
  // (drives the unread blue dot in the sidebar). Set on idle for a non-active
  // session, cleared when the session is selected.
  unreadBySession: Record<string, boolean>;
  // Auth state (real daemon)
  authReady: boolean;
  defaultModel: string | null;
  managedProviderStatus: string | null;
  // Workspace state
  workspaces: AppWorkspace[];
  activeWorkspaceId: string | null;
  fsHome: string | null;
  recentRoots: string[];
  // Root paths the user removed from the sidebar (see HIDDEN_WORKSPACES_KEY).
  hiddenWorkspaceRoots: string[];
  /** Installed external apps that can be used with "Open in app". */
  availableOpenInApps: string[];
  /** Global daemon configuration (secrets redacted). */
  config: AppConfig | null;
  /** Transient BTW side-panel transcript, keyed by forked agent id. */
  sideChatMessagesByAgent: Record<string, AppMessage[]>;
  /** Local sending flag for BTW agents; agent ids are not session ids. */
  sideChatSendingByAgent: Record<string, boolean>;
  /** User message ids sent through BTW so they can be hidden from the main transcript. */
  sideChatUserMessageIdsBySession: Record<string, string[]>;
  /** True when older messages are being fetched for a session (scroll-up lazy load). */
  messagesLoadingMoreBySession: Record<string, boolean>;
  /** Whether the server has more older messages than currently loaded per session. */
  messagesHasMoreBySession: Record<string, boolean>;
  /** True when the last older-message fetch failed for a session. */
  messagesLoadMoreErrorBySession: Record<string, boolean>;
}

const rawState: ExtendedState = reactive({
  ...createInitialState(),
  connected: false,
  serverVersion: '',
  workspaceName: 'kimi-web',
  connection: 'disconnected' as ConnectionState,
  permission: loadPermissionFromStorage(),
  thinking: loadThinkingFromStorage(),
  planMode: loadPlanModeFromStorage(),
  swarmMode: loadSwarmModeFromStorage(),
  goalMode: loadGoalModeFromStorage(),
  loading: false,
  sessionLoading: false,
  queuedBySession: {},
  gitStatusBySession: {},
  promptIdBySession: {},
  sendingBySession: {},
  unreadBySession: loadUnreadFromStorage(),
  authReady: false,
  defaultModel: null,
  managedProviderStatus: null,
  workspaces: [],
  activeWorkspaceId: loadActiveWorkspaceFromStorage(),
  fsHome: null,
  recentRoots: [],
  hiddenWorkspaceRoots: loadHiddenWorkspacesFromStorage(),
  availableOpenInApps: [],
  config: null,
  sideChatMessagesByAgent: {},
  sideChatSendingByAgent: {},
  sideChatUserMessageIdsBySession: {},
  messagesLoadingMoreBySession: {},
  messagesHasMoreBySession: {},
  messagesLoadMoreErrorBySession: {},
});

// Models + Providers reactive state (lazy-loaded, cached)
const models = ref<AppModel[]>([]);
const starredModelIds = ref<string[]>(loadStarredModelsFromStorage());

// Session-scoped skills (slash-invocable). Loaded lazily per session; the active
// session's list feeds the composer's `/` menu.
const skillsBySession = ref<Record<string, AppSkill[]>>({});
const providers = ref<AppProvider[]>([]);

// Background task output polling — mirrors TUI's 1-second refresh.
const TASK_OUTPUT_POLL_INTERVAL_MS = 1000;
const TASK_OUTPUT_POLL_BYTES = 4096;
const TASK_OUTPUT_FINAL_BYTES = 32 * 1024;
let taskOutputPollTimer: ReturnType<typeof setInterval> | null = null;
let lastPolledSessionId: string | undefined;
let fetchedTerminalTaskOutputIds = new Set<string>();

// Model picked while in the "new session draft" state (onboarding composer —
// no backend session exists yet, so POST /profile has nothing to target).
// Applied and cleared when the first prompt creates the session.
const draftModel = ref<string | null>(null);

function modelById(modelId: string | null | undefined): AppModel | undefined {
  if (modelId === undefined || modelId === null || modelId.length === 0) return undefined;
  return models.value.find((m) => m.id === modelId || m.model === modelId);
}

function activeThinkingModel(): AppModel | undefined {
  const activeSession = rawState.activeSessionId
    ? rawState.sessions.find((s) => s.id === rawState.activeSessionId)
    : undefined;
  return modelById(activeSession?.model ?? draftModel.value ?? rawState.defaultModel);
}

function applyThinkingLevel(level: ThinkingLevel): ThinkingLevel {
  const next = coerceThinkingForModel(activeThinkingModel(), level);
  rawState.thinking = next;
  saveThinkingToStorage(next);
  return next;
}

// ~/diff line-by-line view: the file the user tapped + its parsed unified diff.
// Loaded on demand via loadFileDiff(); cleared when the file list is shown.
const selectedDiffPath = ref<string | null>(null);
const fileDiffLines = ref<DiffViewLine[]>([]);
const fileDiffLoading = ref(false);

/**
 * Fetch GET /sessions/{id}/status and fold the live model + context usage back
 * into the cached session, so the status line and the WS `agent.status.updated`
 * path share ONE source of truth (the session). Never throws — an old daemon
 * without /status just keeps the previously-known values.
 */
async function refreshSessionStatus(sessionId: string): Promise<void> {
  let st: AppSessionRuntimeStatus;
  try {
    st = await getKimiWebApi().getSessionStatus(sessionId);
  } catch {
    return; // status endpoint missing/unreachable — keep what we have.
  }
  rawState.sessions = rawState.sessions.map((s) =>
    s.id === sessionId
      ? {
          ...s,
          model: st.model || s.model,
          usage: {
            ...s.usage,
            contextTokens: st.contextTokens,
            contextLimit: st.maxContextTokens,
          },
        }
      : s,
  );
  rawState.swarmMode = st.swarmMode;
  rawState.planMode = st.planMode;
}

/** Persist runtime controls to the active session via POST /profile, then
 *  re-read /status. Fire-and-forget: the UI already updated optimistically. */
function persistSessionProfile(patch: {
  model?: string;
  permissionMode?: string;
  planMode?: boolean;
  swarmMode?: boolean;
  goalObjective?: string;
  goalControl?: 'pause' | 'resume' | 'cancel';
  thinking?: string;
}): void {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  // Promise.resolve wrap: tolerate a sync/undefined return (e.g. test mocks).
  void Promise.resolve(getKimiWebApi().updateSession(sid, patch))
    .then(() => refreshSessionStatus(sid))
    .catch(() => {
      /* ignore — local state already reflects the change */
    });
}

// ---------------------------------------------------------------------------
// Beta: proportional conversation TOC with viewport indicator and hover tooltip.
// Default off; persisted per browser.
// ---------------------------------------------------------------------------
const BETA_TOC_STORAGE_KEY = STORAGE_KEYS.betaToc;
function loadBetaTocFromStorage(): boolean {
  try {
    return safeGetString(BETA_TOC_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}
function saveBetaTocToStorage(v: boolean): void {
  try {
    safeSetString(BETA_TOC_STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    // ignore
  }
}
const betaToc = ref<boolean>(loadBetaTocFromStorage());
function setBetaToc(v: boolean): void {
  betaToc.value = v;
  saveBetaTocToStorage(v);
}

// ---------------------------------------------------------------------------
// Onboarding: a "has the user been onboarded" flag that gates the first-run
// onboarding screen (preferences: language + theme). Persisted; can be reset to
// re-open the screen from the settings popover.
// ---------------------------------------------------------------------------
function loadStringFromStorage(key: string): string {
  try {
    return safeGetString(key) ?? '';
  } catch {
    return '';
  }
}
const onboarded = ref<boolean>(loadStringFromStorage(ONBOARDED_STORAGE_KEY) === '1');
function setOnboarded(done: boolean): void {
  onboarded.value = done;
  try {
    safeSetString(ONBOARDED_STORAGE_KEY, done ? '1' : '0');
  } catch {
    /* ignore */
  }
}

// Singleton WS connection
let eventConn: KimiEventConnection | null = null;

// Monotonic counter for optimistic user-message ids. Date.now() alone collides
// when two prompts are submitted in the same millisecond (e.g. a queued send
// then a steer), which gave both messages the SAME id — breaking Vue keying and
// the prompt_id stamping that dedupes the daemon echo. The counter guarantees a
// unique id per optimistic message.
let optimisticMsgSeq = 0;
function nextOptimisticMsgId(): string {
  optimisticMsgSeq += 1;
  return `msg_opt_${Date.now().toString(36)}_${optimisticMsgSeq}`;
}

// Per-session "a prompt is in flight" flag. Flipped SYNCHRONOUSLY the moment we
// decide to submit (before any await), and cleared when the session returns to
// idle. This gates concurrent prompts: `activity` only turns 'running' after the
// WS turn.started round-trips, so a fast second sendPrompt would otherwise race
// past the queue check and clobber promptIdBySession (breaking abort).
const inFlightPromptSessions = new Set<string>();

// Helper: mutate rawState by applying a reducer on a snapshot then re-assigning fields
function applyEvent(event: ReturnType<typeof toAppEvent>, sessionId: string, seq: number): void {
  const snapshot: KimiClientState = {
    sessions: rawState.sessions,
    activeSessionId: rawState.activeSessionId,
    messagesBySession: rawState.messagesBySession,
    approvalsBySession: rawState.approvalsBySession,
    questionsBySession: rawState.questionsBySession,
    tasksBySession: rawState.tasksBySession,
    goalBySession: rawState.goalBySession,
    lastSeqBySession: rawState.lastSeqBySession,
    compactionBySession: rawState.compactionBySession,
    config: rawState.config,
    warnings: rawState.warnings,
  };
  const next = reduceAppEvent(snapshot, event, { sessionId, seq });
  // Assign back to the reactive proxy
  rawState.sessions = next.sessions;
  rawState.activeSessionId = next.activeSessionId;
  rawState.messagesBySession = next.messagesBySession;
  rawState.approvalsBySession = next.approvalsBySession;
  rawState.questionsBySession = next.questionsBySession;
  rawState.tasksBySession = next.tasksBySession;
  rawState.goalBySession = next.goalBySession;
  rawState.lastSeqBySession = next.lastSeqBySession;
  rawState.compactionBySession = next.compactionBySession;
  rawState.config = next.config ?? null;
  rawState.warnings = next.warnings;

  if (event.type === 'configChanged') {
    rawState.defaultModel = event.config.defaultModel ?? null;
  }

  if (event.type === 'sessionUsageUpdated' && event.sessionId === rawState.activeSessionId && event.swarmMode !== undefined) {
    rawState.swarmMode = event.swarmMode;
  }
  // Reflect the agent's live plan-mode state (e.g. it auto-entered plan mode)
  // in the composer toggle.
  if (event.type === 'sessionUsageUpdated' && event.sessionId === rawState.activeSessionId && event.planMode !== undefined) {
    rawState.planMode = event.planMode;
  }
}

// ---------------------------------------------------------------------------
// WS subscription (lazy, only when a session is selected)
// ---------------------------------------------------------------------------

function connectEventsIfNeeded(): void {
  if (eventConn !== null) return;
  // Guard: jsdom and some environments have no WebSocket
  if (typeof WebSocket === 'undefined') return;

  rawState.connection = 'connecting';

  const api = getKimiWebApi();

  eventConn = api.connectEvents({
    onEvent(appEvent, meta) {
      // Workspace lifecycle events are global (not session-scoped) and update
      // rawState.workspaces directly — they bypass the reducer, which has no
      // workspace state.
      if (
        appEvent.type === 'workspaceCreated' ||
        appEvent.type === 'workspaceUpdated' ||
        appEvent.type === 'workspaceDeleted'
      ) {
        applyWorkspaceEvent(appEvent);
        return;
      }

      // meta carries wire-level seq/sessionId so the reducer can advance
      // lastSeqBySession[sessionId] = seq. Compaction completion appends a
      // persistent divider marker in the reducer (TUI parity: the scrollback
      // is kept, only a marker line records the compaction).
      applyEvent(appEvent, meta.sessionId, meta.seq);

      const sideTarget = sideChatTargetBySession.value[meta.sessionId];
      if (sideTarget) {
        const { agentId } = sideTarget;
        const parentId = meta.sessionId;
        if (appEvent.type === 'agentDelta' && appEvent.agentId === agentId) {
          if (appEvent.delta.text) {
            appendSideChatAssistantText(agentId, parentId, appEvent.delta.text);
          }
        } else if (appEvent.type === 'agentTurnEnded' && appEvent.agentId === agentId) {
          finishSideChatAgent(agentId, parentId);
        } else if (appEvent.type === 'taskProgress' && appEvent.taskId === agentId) {
          appendSideChatAssistantText(agentId, parentId, appEvent.outputChunk);
        } else if (appEvent.type === 'taskCompleted' && appEvent.taskId === agentId) {
          finishSideChatAgent(agentId, parentId, appEvent.outputPreview);
        }
      }

      // The daemon's prompt.submitted event is projected as a user messageCreated
      // carrying the real prompt_id. When the HTTP submit response is lost
      // (timeout / network error) this is the fallback that lets Stop work.
      if (
        appEvent.type === 'messageCreated' &&
        appEvent.message.role === 'user' &&
        appEvent.message.promptId !== undefined
      ) {
        const sid = appEvent.message.sessionId;
        if (rawState.promptIdBySession[sid] !== appEvent.message.promptId) {
          rawState.promptIdBySession = {
            ...rawState.promptIdBySession,
            [sid]: appEvent.message.promptId,
          };
        }
      }

      if (appEvent.type === 'assistantDelta' && meta.sessionId === rawState.activeSessionId) {
        appearance.recordMoonDelta((appEvent.delta.text?.length ?? 0) + (appEvent.delta.thinking?.length ?? 0));
      }

      // Turn-end cleanup for the session the event belongs to — including
      // sessions running in the background (see onSessionIdle).
      // Turn-end: both 'idle' and 'aborted' mean the prompt is no longer in
      // flight, so both must flush in-flight/queued state. (Awaiting-* is still
      // in flight — it's waiting on the user — and must NOT flush.)
      if (
        appEvent.type === 'sessionStatusChanged' &&
        (appEvent.status === 'idle' || appEvent.status === 'aborted')
      ) {
        onSessionIdle(appEvent.sessionId);
      }

      // Permission auto-approve: CLIENT-SIDE POLICY until the daemon exposes a
      // permission endpoint. When permission is 'auto' or 'yolo' and an approval
      // request arrives, immediately respond with 'approved'.
      if (appEvent.type === 'approvalRequested') {
        const perm = rawState.permission;
        if (perm === 'auto' || perm === 'yolo') {
          void respondApproval(appEvent.approval.approvalId, {
            decision: 'approved',
            scope: perm === 'yolo' ? 'session' : undefined,
          });
        }
      }
    },

    onResync(sessionId: string, currentSeq: number, epoch?: string) {
      // The server-announced cursor is only a hint; the snapshot fetch
      // returns the authoritative {asOfSeq, epoch} and re-subscribes.
      if (epoch !== undefined) epochBySession[sessionId] = epoch;
      void currentSeq;
      void syncSessionFromSnapshot(sessionId);
    },

    onError(_code: number, msg: string, _fatal: boolean) {
      pushWarning({
        severity: 'error',
        title: i18n.global.t('warnings.wsTitle'),
        message: msg,
        details: [warningDetail('message', msg)].filter(
          (detail): detail is AppNoticeDetail => detail !== undefined,
        ),
      });
    },

    onConnectionChange(connected: boolean) {
      rawState.connected = connected;
      rawState.connection = connected ? 'connected' : 'disconnected';
    },
  });
}

// Journal epoch per session, learned from snapshots / resync frames. Not
// reactive — only consulted when building the subscribe cursor.
const epochBySession: Record<string, string> = {};

// Sessions created locally in this client instance are known to be empty until
// they receive their first message. This is more reliable than the daemon's
// messageCount field, which can be stale for old sessions and would otherwise
// flash the empty-composer before the real snapshot arrives.
const sessionsKnownEmpty = new Set<string>();

/**
 * v2 initial sync (IM-style rebuild): fetch the atomic session snapshot,
 * install its state, seed the projector's in-flight turn, then subscribe the
 * WS at the snapshot's `{seq: asOfSeq, epoch}` cursor. The watermark ties
 * the REST snapshot to the event stream — no gap, no duplication.
 */
type SyncSessionResult = 'ok' | 'not-found' | 'failed';

function isSessionNotFoundError(err: unknown): boolean {
  if (isDaemonApiError(err) && err.code === SESSION_NOT_FOUND_CODE) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === SESSION_NOT_FOUND_CODE
  );
}

function warningDetail(labelKey: string, value: unknown): AppNoticeDetail | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return { label: i18n.global.t(`warnings.details.${labelKey}`), value: formatDetailValue(value) };
}

function formatDetailValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message ? `${value.name}: ${value.message}` : value.name;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorName(err: unknown): string | undefined {
  return err instanceof Error
    ? err.name
    : typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
      ? (err as { name: string }).name
      : undefined;
}

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error
    ? err.message
    : typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : undefined;
}

function errorDetails(operation: string, err: unknown, sessionId?: string): AppNoticeDetail[] {
  const details: Array<AppNoticeDetail | undefined> = [
    warningDetail('operation', operation),
    warningDetail('sessionId', sessionId),
  ];

  if (isDaemonNetworkError(err)) {
    details.push(
      warningDetail('request', `${err.method} ${err.path}`),
      warningDetail('endpoint', err.url),
      warningDetail('requestId', err.requestId),
      warningDetail('phase', err.phase),
      warningDetail('timeout', `${err.timeoutMs}ms`),
      warningDetail('status', err.status === undefined ? undefined : `${err.status} ${err.statusText ?? ''}`.trim()),
      warningDetail('contentType', err.contentType),
      warningDetail('responsePreview', err.bodyPreview),
      warningDetail('cause', err.cause),
    );
  } else if (isDaemonApiError(err)) {
    details.push(
      warningDetail('code', err.code),
      warningDetail('requestId', err.requestId),
      warningDetail('message', err.message),
      warningDetail('details', err.details),
    );
  } else {
    details.push(
      warningDetail('errorName', errorName(err)),
      warningDetail('message', errorMessage(err) ?? formatDetailValue(err)),
    );
  }

  return details.filter((detail): detail is AppNoticeDetail => detail !== undefined);
}

function operationFailureNotice(
  operation: string,
  err: unknown,
  opts: { title?: string; message?: string; sessionId?: string } = {},
): AppNotice {
  const network = isDaemonNetworkError(err);
  const api = isDaemonApiError(err);
  const title =
    opts.title ??
    (network
      ? i18n.global.t('warnings.daemonNetworkTitle')
      : api
        ? i18n.global.t('warnings.daemonApiTitle')
        : i18n.global.t('warnings.operationFailedTitle'));
  const message =
    opts.message ??
    (network
      ? i18n.global.t('warnings.daemonNetworkMessage')
      : api
        ? err.message
        : i18n.global.t('warnings.operationFailedMessage'));
  return {
    severity: 'error',
    title,
    message,
    details: errorDetails(operation, err, opts.sessionId),
  };
}

function pushWarning(warning: AppWarning): void {
  rawState.warnings = [...rawState.warnings, warning];
}

function pushOperationFailure(
  operation: string,
  err: unknown,
  opts?: { title?: string; message?: string; sessionId?: string },
): void {
  pushWarning(operationFailureNotice(operation, err, opts));
}

// Goal-specific protocol error codes (40913–40918). The daemon now returns
// these instead of a bare 500, so map them to a friendly explanation rather
// than dumping the raw envelope message on the user.
const GOAL_ERROR_KEYS: Record<number, string> = {
  40913: 'warnings.goal.alreadyExists',
  40914: 'warnings.goal.notFound',
  40915: 'warnings.goal.statusInvalid',
  40916: 'warnings.goal.notResumable',
  40918: 'warnings.goal.objectiveTooLong',
};

function goalErrorMessage(err: unknown): string | undefined {
  if (!isDaemonApiError(err)) return undefined;
  const key = GOAL_ERROR_KEYS[err.code];
  return key ? i18n.global.t(key) : undefined;
}

async function handleSessionNotFound(sessionId: string): Promise<void> {
  rawState.sessions = rawState.sessions.filter((s) => s.id !== sessionId);
  delete rawState.messagesBySession[sessionId];
  delete rawState.approvalsBySession[sessionId];
  delete rawState.questionsBySession[sessionId];
  delete rawState.tasksBySession[sessionId];
  delete rawState.goalBySession[sessionId];
  delete rawState.gitStatusBySession[sessionId];
  delete rawState.lastSeqBySession[sessionId];
  delete rawState.compactionBySession[sessionId];
  delete rawState.messagesLoadingMoreBySession[sessionId];
  delete rawState.messagesHasMoreBySession[sessionId];
  delete rawState.messagesLoadMoreErrorBySession[sessionId];
  delete epochBySession[sessionId];
  sessionsKnownEmpty.delete(sessionId);

  if (rawState.activeSessionId !== sessionId) return;

  const next = rawState.sessions[0];
  if (next) {
    await selectSession(next.id, { urlMode: 'replace' });
  } else {
    rawState.activeSessionId = undefined;
    rawState.sessionLoading = false;
    writeSessionUrl(undefined, 'replace');
  }
}

async function syncSessionFromSnapshot(sessionId: string): Promise<SyncSessionResult> {
  try {
    const api = getKimiWebApi();
    const snap = await api.getSessionSnapshot(sessionId);

    rawState.sessions = rawState.sessions.map((s) =>
      s.id === sessionId
        ? {
            ...snap.session,
            model:
              snap.session.model && snap.session.model.length > 0
                ? snap.session.model
                : s.model,
          }
        : s,
    );
    rawState.messagesBySession = {
      ...rawState.messagesBySession,
      [sessionId]: snap.messages,
    };
    rawState.messagesHasMoreBySession = {
      ...rawState.messagesHasMoreBySession,
      [sessionId]: snap.hasMoreMessages,
    };
    rawState.approvalsBySession = {
      ...rawState.approvalsBySession,
      [sessionId]: snap.pendingApprovals,
    };
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sessionId]: snap.pendingQuestions,
    };
    rawState.lastSeqBySession = {
      ...rawState.lastSeqBySession,
      [sessionId]: snap.asOfSeq,
    };
    epochBySession[sessionId] = snap.epoch;

    connectEventsIfNeeded();
    if (eventConn) {
      // Seed BEFORE subscribing: the in-flight assistant message must exist
      // before live deltas (aligned by wire offset) start appending to it.
      eventConn.seedSnapshot(sessionId, snap);
      eventConn.subscribe(sessionId, { seq: snap.asOfSeq, epoch: snap.epoch });
    }
    return 'ok';
  } catch (err) {
    if (isSessionNotFoundError(err)) {
      await handleSessionNotFound(sessionId);
      return 'not-found';
    }
    pushOperationFailure('getSessionSnapshot', err, {
      title: i18n.global.t('warnings.sessionSnapshotTitle'),
      message: i18n.global.t('warnings.sessionSnapshotMessage'),
      sessionId,
    });
    return 'failed';
  }
}

const MESSAGES_PAGE_SIZE = 50;

async function loadOlderMessages(sessionId: string): Promise<void> {
  if (rawState.messagesLoadingMoreBySession[sessionId]) return;
  const current = rawState.messagesBySession[sessionId];
  if (!current || current.length === 0) return;

  const beforeId = current[0]!.id;
  rawState.messagesLoadingMoreBySession = {
    ...rawState.messagesLoadingMoreBySession,
    [sessionId]: true,
  };
  rawState.messagesLoadMoreErrorBySession = {
    ...rawState.messagesLoadMoreErrorBySession,
    [sessionId]: false,
  };
  try {
    const page = await getKimiWebApi().listMessages(sessionId, {
      beforeId,
      pageSize: MESSAGES_PAGE_SIZE,
    });
    // Server returns newest-first; the UI keeps messages in chronological order.
    const older = [...page.items].reverse();
    // Live events may have appended messages while the request was in flight;
    // read the latest array so those messages are not overwritten.
    const latest = rawState.messagesBySession[sessionId] ?? current;
    rawState.messagesBySession = {
      ...rawState.messagesBySession,
      [sessionId]: [...older, ...latest],
    };
    rawState.messagesHasMoreBySession = {
      ...rawState.messagesHasMoreBySession,
      [sessionId]: page.hasMore,
    };
  } catch (err) {
    rawState.messagesLoadMoreErrorBySession = {
      ...rawState.messagesLoadMoreErrorBySession,
      [sessionId]: true,
    };
    pushOperationFailure('loadOlderMessages', err, { sessionId });
  } finally {
    rawState.messagesLoadingMoreBySession = {
      ...rawState.messagesLoadingMoreBySession,
      [sessionId]: false,
    };
  }
}

async function loadTasksForSession(sessionId: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    const taskList = await api.listTasks(sessionId);
    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      // Keep WS-delivered swarm subagents that REST /tasks omits (see keepLiveSubagents).
      [sessionId]: keepLiveSubagents(taskList, rawState.tasksBySession[sessionId] ?? []),
    };
    // Completed tasks may have real terminal output that never streamed over
    // WS. Fetch it once now so the rows are expandable when the session opens.
    await fetchTerminalTaskOutputs(sessionId, taskList);
  } catch {
    // Tasks are side data; old/stale sessions may fail without blocking messages.
  }
}

/**
 * Fetch the final output snapshot for terminal tasks that lack real streamed
 * outputLines. Called once after loading the task list so already-completed
 * tasks are clickable immediately.
 */
async function fetchTerminalTaskOutputs(sessionId: string, taskList?: AppTask[]): Promise<void> {
  if (rawState.activeSessionId !== sessionId) return;

  const tasks = taskList ?? rawState.tasksBySession[sessionId] ?? [];
  const api = getKimiWebApi();
  const outputByTaskId = new Map<string, { preview: string; bytes?: number }>();

  await Promise.all(
    tasks.map(async (task) => {
      const isTerminal =
        task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
      if (!isTerminal) return;
      if (fetchedTerminalTaskOutputIds.has(task.id)) return;
      if ((task.outputLines?.length ?? 0) > 0) return;

      try {
        const withOutput = await api.getTask(sessionId, task.id, {
          withOutput: true,
          outputBytes: TASK_OUTPUT_FINAL_BYTES,
        });
        if (withOutput.outputPreview !== undefined) {
          outputByTaskId.set(task.id, {
            preview: withOutput.outputPreview,
            bytes: withOutput.outputBytes,
          });
        }
      } catch {
        // Task may have finished between listTasks and getTask; ignore.
      } finally {
        fetchedTerminalTaskOutputIds.add(task.id);
      }
    }),
  );

  if (outputByTaskId.size === 0) return;

  const existing = rawState.tasksBySession[sessionId] ?? [];
  rawState.tasksBySession = {
    ...rawState.tasksBySession,
    [sessionId]: existing.map((t) => {
      const polled = outputByTaskId.get(t.id);
      if (!polled) return t;
      return { ...t, outputPreview: polled.preview, outputBytes: polled.bytes };
    }),
  };
}

/**
 * Poll background task output for a session. Mirrors the TUI's 1-second refresh:
 * refresh the task list, then fetch tail output for running tasks and a final
 * snapshot for terminal tasks that haven't received output yet.
 */
async function pollTaskOutputForSession(sessionId: string): Promise<void> {
  if (rawState.activeSessionId !== sessionId) return;

  const api = getKimiWebApi();
  let taskList: AppTask[];
  try {
    taskList = await api.listTasks(sessionId);
  } catch {
    return;
  }

  const outputByTaskId = new Map<string, { preview: string; bytes?: number }>();

  await Promise.all(
    taskList.map(async (task) => {
      const isRunning = task.status === 'running';
      const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
      if (!isRunning && !isTerminal) return;

      // Running tasks: poll tail continuously. Terminal tasks: fetch a final
      // snapshot once if we have not already received real streamed output.
      // outputPreview may be a placeholder (`$ <command>`) or a partial tail,
      // so we intentionally do not skip terminal tasks just because outputPreview
      // is present.
      if (isTerminal) {
        if (fetchedTerminalTaskOutputIds.has(task.id)) return;
        if ((task.outputLines?.length ?? 0) > 0) return;
      }

      try {
        const withOutput = await api.getTask(sessionId, task.id, {
          withOutput: true,
          outputBytes: isRunning ? TASK_OUTPUT_POLL_BYTES : TASK_OUTPUT_FINAL_BYTES,
        });
        if (withOutput.outputPreview !== undefined) {
          outputByTaskId.set(task.id, {
            preview: withOutput.outputPreview,
            bytes: withOutput.outputBytes,
          });
        }
      } catch {
        // Task may have finished between listTasks and getTask; ignore.
      } finally {
        if (isTerminal) {
          fetchedTerminalTaskOutputIds.add(task.id);
        }
      }
    }),
  );

  const existing = rawState.tasksBySession[sessionId] ?? [];
  const existingById = new Map(existing.map((t) => [t.id, t] as const));

  const refreshed: AppTask[] = taskList.map((fresh) => {
    const old = existingById.get(fresh.id);
    const polled = outputByTaskId.get(fresh.id);
    return {
      ...fresh,
      // Preserve any WS-driven outputLines (future taskProgress events).
      outputLines: old?.outputLines,
      outputPreview: polled?.preview ?? old?.outputPreview,
      outputBytes: polled?.bytes ?? old?.outputBytes,
    };
  });

  rawState.tasksBySession = {
    ...rawState.tasksBySession,
    // Keep WS-delivered swarm subagents that REST /tasks omits (see keepLiveSubagents).
    [sessionId]: keepLiveSubagents(refreshed, existing),
  };
}

function startTaskOutputPolling(sessionId: string): void {
  if (taskOutputPollTimer !== null && lastPolledSessionId === sessionId) {
    return;
  }
  stopTaskOutputPolling();
  lastPolledSessionId = sessionId;
  void pollTaskOutputForSession(sessionId);
  taskOutputPollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    if (rawState.activeSessionId === sessionId) {
      void pollTaskOutputForSession(sessionId);
    } else {
      stopTaskOutputPolling();
    }
  }, TASK_OUTPUT_POLL_INTERVAL_MS);
}

function stopTaskOutputPolling(): void {
  if (taskOutputPollTimer !== null) {
    clearInterval(taskOutputPollTimer);
    taskOutputPollTimer = null;
  }
  lastPolledSessionId = undefined;
  fetchedTerminalTaskOutputIds.clear();
}

async function loadSkillsForSession(sessionId: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    const list = await api.listSkills(sessionId);
    skillsBySession.value = { ...skillsBySession.value, [sessionId]: list };
  } catch {
    // Skills are side data; an older daemon without /skills just yields no
    // slash-skills, the built-in commands still work.
  }
}

function hasLoadedMessages(sessionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(rawState.messagesBySession, sessionId);
}

function subscribeToSessionEvents(sessionId: string): void {
  connectEventsIfNeeded();
  if (eventConn) {
    const seq = rawState.lastSeqBySession[sessionId] ?? 0;
    const epoch = epochBySession[sessionId];
    eventConn.subscribe(sessionId, { seq, epoch });
  }
}

function refreshSessionSidecars(sessionId: string): void {
  void loadTasksForSession(sessionId);
  void loadGitStatus(sessionId);
  void refreshSessionStatus(sessionId);
  if (!Object.prototype.hasOwnProperty.call(skillsBySession.value, sessionId)) {
    void loadSkillsForSession(sessionId);
  }
}

// ---------------------------------------------------------------------------
// View-model mappers
// ---------------------------------------------------------------------------

/** Whether the session should show the "working" spinner. Only a `running`
    session qualifies — `awaiting*` is waiting on the user (not working) and
    `aborted` is finished, so neither spins. Additionally, a session whose only
    running task is its BTW side-channel agent should not look busy. When tasks
    have not been loaded yet — e.g. right after a page refresh — we trust the
    daemon-reported `running` status rather than hiding the spinner. */
function isSessionEffectivelyRunning(sessionId: string): boolean {
  const session = rawState.sessions.find((s) => s.id === sessionId);
  if (!session) return false;
  if (session.status !== 'running') return false;
  const hiddenBtwAgentId = sideChatTargetBySession.value[sessionId]?.agentId;
  const tasks = rawState.tasksBySession[sessionId] ?? [];
  const runningTasks = tasks.filter((t) => t.status === 'running');
  if (runningTasks.length === 0) {
    // No task list yet (fresh refresh) — trust the daemon-reported session status,
    // unless the only active work is a BTW side-chat agent. In that window the
    // side chat is sending and its task hasn't been loaded, so suppress the main
    // session spinner so the main composer stays usable.
    if (hiddenBtwAgentId && rawState.sideChatSendingByAgent[hiddenBtwAgentId]) {
      return false;
    }
    return true;
  }
  return runningTasks.some((t) => t.id !== hiddenBtwAgentId);
}

/** Format createdAt/updatedAt into a short display string */
function formatTime(iso: string, _status: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffH = diffMs / 3600000;
    if (diffMs < 60000) return i18n.global.t('sessions.justNow');
    if (diffH < 1) return `${Math.round(diffMs / 60000)}m`;
    if (diffH < 24) return `${Math.round(diffH)}h`;
    return d.toLocaleDateString(i18n.global.locale.value, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const SESSION_TIME_CLOCK_INTERVAL_MS = 30_000;
const sessionTimeClock = ref(0);
let sessionTimeClockTimer: ReturnType<typeof setInterval> | null = null;

function ensureSessionTimeClock(): void {
  if (sessionTimeClockTimer !== null) return;
  sessionTimeClockTimer = setInterval(() => {
    sessionTimeClock.value = (sessionTimeClock.value + 1) % Number.MAX_SAFE_INTEGER;
  }, SESSION_TIME_CLOCK_INTERVAL_MS);
  (sessionTimeClockTimer as { unref?: () => void }).unref?.();
}

function stopSessionTimeClock(): void {
  if (sessionTimeClockTimer === null) return;
  clearInterval(sessionTimeClockTimer);
  sessionTimeClockTimer = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(stopSessionTimeClock);
}

/** Build DiffLine[] from old_text/new_text strings */
function buildDiffLines(oldText: string, newText: string): DiffLine[] {
  const removed = oldText.split('\n');
  const added = newText.split('\n');
  const lines: DiffLine[] = [];
  removed.forEach((text, i) => {
    lines.push({ kind: 'rem', gutter: String(i + 1), text: `- ${text}` });
  });
  added.forEach((text, i) => {
    lines.push({ kind: 'add', gutter: String(i + 1), text: `+ ${text}` });
  });
  return lines;
}

/** Build ApprovalBlock from AppApprovalRequest (discriminated union) */
function buildApprovalBlock(a: AppApprovalRequest): ApprovalBlock {
  // Cast display to a loose dict for defensive reading
  const d = (a.display ?? {}) as Record<string, unknown>;
  const kind = typeof d.kind === 'string' ? d.kind : '';

  // diff
  if (kind === 'diff') {
    const path = typeof d.path === 'string' ? d.path : '';
    if (Array.isArray(d.diff)) {
      return { kind: 'diff', path, diff: d.diff as DiffLine[] };
    }
    if (typeof d.old_text === 'string' && typeof d.new_text === 'string') {
      return { kind: 'diff', path, diff: buildDiffLines(d.old_text, d.new_text) };
    }
    return { kind: 'diff', path, diff: [] };
  }

  // shell / command
  if (kind === 'shell' || kind === 'command') {
    const command = typeof d.command === 'string' ? d.command : a.action;
    const cwd = typeof d.cwd === 'string' ? d.cwd : undefined;
    const danger = typeof d.danger === 'string' ? d.danger : undefined;
    return { kind: 'shell', command, cwd, danger };
  }

  // file_content / file
  if (kind === 'file_content' || kind === 'file') {
    const path = typeof d.path === 'string' ? d.path : '';
    const content = typeof d.content === 'string' ? d.content : '';
    const language = typeof d.language === 'string' ? d.language : undefined;
    return { kind: 'file', path, content, language };
  }

  // file_op / fileop
  if (kind === 'file_op' || kind === 'fileop') {
    const op = typeof d.operation === 'string' ? d.operation : (typeof d.op === 'string' ? d.op : kind);
    const path = typeof d.path === 'string' ? d.path : '';
    const detail = typeof d.detail === 'string' ? d.detail : undefined;
    return { kind: 'fileop', op, path, detail };
  }

  // url_fetch / url
  if (kind === 'url_fetch' || kind === 'url') {
    const url = typeof d.url === 'string' ? d.url : a.action;
    const method = typeof d.method === 'string' ? d.method : undefined;
    return { kind: 'url', method, url };
  }

  // search
  if (kind === 'search') {
    const query = typeof d.query === 'string' ? d.query : a.action;
    const scope = typeof d.scope === 'string' ? d.scope : undefined;
    return { kind: 'search', query, scope };
  }

  // invocation / agent_call / skill_call
  if (kind === 'invocation' || kind === 'agent_call' || kind === 'skill_call') {
    const kind2 = typeof d.kind === 'string' ? d.kind : kind;
    const name = typeof d.name === 'string' ? d.name : a.toolName;
    const description = typeof d.description === 'string' ? d.description : undefined;
    return { kind: 'invocation', kind2, name, description };
  }

  // todo / todo_list
  if (kind === 'todo' || kind === 'todo_list') {
    const rawItems = Array.isArray(d.items) ? d.items : [];
    const items = rawItems.map((item: unknown) => {
      const it = (item ?? {}) as Record<string, unknown>;
      return {
        title: typeof it.title === 'string' ? it.title : '',
        status: typeof it.status === 'string' ? it.status : 'pending',
      };
    });
    return { kind: 'todo', items };
  }

  // Unknown daemon display.kind → 'generic' with summary = action
  return { kind: 'generic', summary: a.action };
}

/** Map AppQuestionRequest to UIQuestion */
function toUiQuestion(q: AppQuestionRequest): UIQuestion {
  return {
    questionId: q.questionId,
    sessionId: q.sessionId,
    questions: q.questions.map((qi) => ({
      id: qi.id,
      question: qi.question,
      header: qi.header,
      body: qi.body,
      options: qi.options.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
        recommended: o.recommended,
      })),
      multiSelect: qi.multiSelect,
      allowOther: qi.allowOther,
      otherLabel: qi.otherLabel,
    })),
  };
}

// messagesToTurns is imported from ./messagesToTurns (extracted module that
// groups consecutive assistant messages by promptId into a single turn).

/**
 * Try to recover the original bash command for a background task when the
 * task object itself does not carry it. The command lives in the matching
 * `Bash` tool_use message whose tool_result mentions this task's id.
 */
function findBashCommandForTask(task: AppTask): string | undefined {
  const messages = rawState.messagesBySession[task.sessionId];
  if (!messages || messages.length === 0) return undefined;

  const bashCommandsByToolCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type !== 'toolUse') continue;
      if (part.toolName !== 'Bash' && part.toolName !== 'bash') continue;
      const input = part.input as { command?: unknown } | undefined;
      const command = input && typeof input.command === 'string' ? input.command : undefined;
      if (command) {
        bashCommandsByToolCallId.set(part.toolCallId, command);
      }
    }
  }
  if (bashCommandsByToolCallId.size === 0) return undefined;

  const taskIdMarker = `task_id: ${task.id}`;
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    for (const part of msg.content) {
      if (part.type !== 'toolResult') continue;
      const outputText =
        typeof part.output === 'string'
          ? part.output
          : part.output !== undefined
            ? JSON.stringify(part.output)
            : '';
      if (outputText.includes(taskIdMarker)) {
        const command = bashCommandsByToolCallId.get(part.toolCallId);
        if (command) return command;
      }
    }
  }
  return undefined;
}

/** Map AppTask to UI TaskItem */
function toUiTask(task: AppTask): TaskItem {
  let state: TaskState;
  if (task.status === 'running') {
    state = 'run';
  } else if (task.status === 'completed') {
    state = 'done';
  } else {
    state = 'fail';
  }

  // Compute timing string
  let timing = '';
  if (task.status === 'running' && task.startedAt) {
    const elapsed = Math.round((Date.now() - new Date(task.startedAt).getTime()) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timing = i18n.global.t('tasks.timingRunning', { time: `${m}:${String(s).padStart(2, '0')}` });
  } else if (task.completedAt && task.startedAt) {
    const elapsed = Math.round((new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 1000);
    timing = i18n.global.t('tasks.timingDone', { sec: elapsed });
  } else {
    timing = task.status;
  }

  const output: string[] | undefined =
    task.outputLines && task.outputLines.length > 0
      ? task.outputLines
      : task.outputPreview
        ? task.outputPreview.split(/\r?\n/)
        : undefined;

  // Show the real terminal command for bash tasks so users can see what is
  // running without expanding the row. Fall back to the matching Bash tool_use
  // message when the task itself does not carry the command field.
  const command = task.command ?? findBashCommandForTask(task);
  const meta = task.kind === 'bash' && command ? `$ ${command}` : undefined;

  return {
    id: task.id,
    name: task.description,
    kind: task.kind,
    state,
    timing,
    meta,
    output,
  };
}

// ---------------------------------------------------------------------------
// Computed view props
// ---------------------------------------------------------------------------

const workspace = computed<Workspace>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  const branch = activeSession ? activeSession.cwd.split('/').pop() ?? activeSession.cwd : 'main';
  return {
    name: rawState.workspaceName,
    branch,
  };
});

const sessions = computed<Session[]>(() => {
  void sessionTimeClock.value;
  return rawState.sessions
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((s) => ({
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt, s.status),
      status: s.status,
      busy: isSessionEffectivelyRunning(s.id),
    }));
});

const activeSessionId = computed<string>(() => rawState.activeSessionId ?? '');

/** Slash-invocable skills for the active session (feeds the composer `/` menu). */
const skills = computed<AppSkill[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return skillsBySession.value[sid] ?? [];
});

const isSending = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  return rawState.sendingBySession[sid] ?? false;
});

const activeAppTasks = computed<AppTask[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const hiddenBtwAgentId = sideChatTargetBySession.value[sid]?.agentId;
  return (rawState.tasksBySession[sid] ?? []).filter((task) => task.id !== hiddenBtwAgentId);
});

const turns = computed<ChatTurn[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const hiddenIds = new Set(rawState.sideChatUserMessageIdsBySession[sid] ?? []);
  const messages = (rawState.messagesBySession[sid] ?? []).filter((m) => !hiddenIds.has(m.id));
  const approvals = rawState.approvalsBySession[sid] ?? [];
  return messagesToTurns(
    messages,
    approvals,
    (fileId) => getKimiWebApi().getFileUrl(fileId),
    activity.value !== 'idle',
    activeAppTasks.value,
  );
});

// ---------------------------------------------------------------------------
// Side chat ("BTW") — a TUI-style forked agent rendered as a session tab.
// It is not a child session and never appears in the sidebar. Each session can
// have its own side chat; state is keyed by session id, while messages are
// keyed by agent id so they survive session switches.
// ---------------------------------------------------------------------------
const sideChatTargetBySession = ref<Record<string, { agentId: string }>>({});

const activeSideChatTarget = computed<{ parentId: string; agentId: string } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const target = sideChatTargetBySession.value[sid];
  return target ? { parentId: sid, agentId: target.agentId } : null;
});

const sideChatSessionId = computed<string | null>(
  () => activeSideChatTarget.value?.parentId ?? null,
);
const sideChatVisible = computed<boolean>(() => activeSideChatTarget.value !== null);

const sideChatSending = computed<boolean>(() => {
  const target = activeSideChatTarget.value;
  return target ? Boolean(rawState.sideChatSendingByAgent[target.agentId]) : false;
});

const sideChatRunning = computed<boolean>(() => {
  const target = activeSideChatTarget.value;
  if (!target) return false;
  if (rawState.sideChatSendingByAgent[target.agentId]) return true;
  return (rawState.tasksBySession[target.parentId] ?? []).some(
    (task) => task.id === target.agentId && task.status === 'running',
  );
});

const sideChatTurns = computed<ChatTurn[]>(() => {
  const target = activeSideChatTarget.value;
  if (!target) return [];
  const messages = rawState.sideChatMessagesByAgent[target.agentId] ?? [];
  return messagesToTurns(
    messages,
    [],
    (fileId) => getKimiWebApi().getFileUrl(fileId),
    sideChatRunning.value,
    [],
  );
});

function updateSideChatMessages(agentId: string, update: (messages: AppMessage[]) => AppMessage[]): void {
  rawState.sideChatMessagesByAgent = {
    ...rawState.sideChatMessagesByAgent,
    [agentId]: update(rawState.sideChatMessagesByAgent[agentId] ?? []),
  };
}

function appendSideChatMessage(agentId: string, message: AppMessage): void {
  updateSideChatMessages(agentId, (messages) => [...messages, message]);
}

function removeLastSideChatUserMessage(agentId: string): void {
  updateSideChatMessages(agentId, (messages) => {
    const idx = [...messages].reverse().findIndex((message) => message.role === 'user');
    if (idx === -1) return messages;
    const removeIndex = messages.length - 1 - idx;
    return messages.filter((_, index) => index !== removeIndex);
  });
}

function stampLastSideChatUserPrompt(agentId: string, promptId: string): void {
  updateSideChatMessages(agentId, (messages) => {
    const next = [...messages];
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const message = next[i]!;
      if (message.role !== 'user') continue;
      next[i] = { ...message, promptId: message.promptId ?? promptId };
      return next;
    }
    return messages;
  });
}

function appendSideChatAssistantText(agentId: string, sessionId: string, chunk: string): void {
  if (!chunk) return;
  updateSideChatMessages(agentId, (messages) => {
    const last = messages.at(-1);
    if (last?.role === 'assistant') {
      const first = last.content[0];
      const text = first?.type === 'text' ? first.text : '';
      return [
        ...messages.slice(0, -1),
        {
          ...last,
          content: [{ type: 'text', text: `${text}${chunk}` }],
        },
      ];
    }
    return [
      ...messages,
      {
        id: nextOptimisticMsgId(),
        sessionId,
        role: 'assistant',
        content: [{ type: 'text', text: chunk }],
        createdAt: new Date().toISOString(),
      },
    ];
  });
}

function finishSideChatAgent(agentId: string, sessionId: string, outputPreview?: string): void {
  rawState.sideChatSendingByAgent = { ...rawState.sideChatSendingByAgent, [agentId]: false };
  if (!outputPreview) return;
  const messages = rawState.sideChatMessagesByAgent[agentId] ?? [];
  const last = messages.at(-1);
  const lastText = last?.role === 'assistant' && last.content[0]?.type === 'text'
    ? last.content[0].text
    : '';
  if (lastText.trim().length > 0) return;
  appendSideChatAssistantText(agentId, sessionId, outputPreview);
}

/** Open (creating if needed) the side chat for the active session; optionally send a first prompt. */
async function openSideChat(initialPrompt?: string): Promise<void> {
  const parent = rawState.activeSessionId;
  if (!parent) return;
  // Reuse the existing side chat for this session if it already exists.
  if (!sideChatTargetBySession.value[parent]) {
    let agentId: string;
    try {
      ({ agentId } = await getKimiWebApi().startBtw(parent));
    } catch (err) {
      pushOperationFailure('openSideChat', err, { sessionId: parent });
      return;
    }
    rawState.sideChatMessagesByAgent = {
      ...rawState.sideChatMessagesByAgent,
      [agentId]: rawState.sideChatMessagesByAgent[agentId] ?? [],
    };
    sideChatTargetBySession.value = {
      ...sideChatTargetBySession.value,
      [parent]: { agentId },
    };
    connectEventsIfNeeded();
    eventConn?.markSideChannelAgent(agentId);
  }
  if (initialPrompt && initialPrompt.trim()) {
    await sendSideChatPrompt(initialPrompt.trim());
  }
}

function closeSideChat(): void {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  const { [sid]: _removed, ...rest } = sideChatTargetBySession.value;
  void _removed;
  sideChatTargetBySession.value = rest;
}

/** Send a plain prompt to the side-chat child (no plan/swarm/goal modes). */
async function sendSideChatPrompt(text: string): Promise<void> {
  const target = activeSideChatTarget.value;
  const trimmed = text.trim();
  if (!target || !trimmed) return;
  const sid = target.parentId;
  const agentId = target.agentId;
  rawState.sideChatSendingByAgent = { ...rawState.sideChatSendingByAgent, [agentId]: true };
  const userMsg: AppMessage = {
    id: nextOptimisticMsgId(),
    sessionId: sid,
    role: 'user',
    content: [{ type: 'text', text: trimmed }],
    createdAt: new Date().toISOString(),
    metadata: { 'kimiWeb.optimisticUserMessage': true },
  };
  appendSideChatMessage(agentId, userMsg);
  try {
    const result = await getKimiWebApi().submitPrompt(sid, {
      content: [{ type: 'text', text: trimmed }],
      agentId,
    });
    stampLastSideChatUserPrompt(agentId, result.promptId);
    rawState.sideChatUserMessageIdsBySession = {
      ...rawState.sideChatUserMessageIdsBySession,
      [sid]: [...(rawState.sideChatUserMessageIdsBySession[sid] ?? []), result.userMessageId],
    };
  } catch (err) {
    pushOperationFailure('sendSideChatPrompt', err, { sessionId: sid });
    removeLastSideChatUserMessage(agentId);
    rawState.sideChatSendingByAgent = { ...rawState.sideChatSendingByAgent, [agentId]: false };
  }
}

// When a session is deleted, drop its side-chat target so it cannot leak into a
// later session that happens to reuse the same id.
function clearSideChatForSession(sessionId: string): void {
  if (!sideChatTargetBySession.value[sessionId]) return;
  const { [sessionId]: _removed, ...rest } = sideChatTargetBySession.value;
  void _removed;
  sideChatTargetBySession.value = rest;
}

// A 1-second clock that only ticks while a task is running, so a running task's
// elapsed-time label keeps counting up. toUiTask reads Date.now() once per
// evaluation; without this the `tasks` computed only re-ran when tasksBySession
// changed, freezing the timer at whatever it read on the first render.
const taskClock = ref(0);
let taskClockTimer: ReturnType<typeof setInterval> | null = null;
watch(
  () => activeAppTasks.value.some((tk) => tk.status === 'running'),
  (hasRunning) => {
    if (hasRunning && taskClockTimer === null) {
      taskClockTimer = setInterval(() => {
        taskClock.value = (taskClock.value + 1) % Number.MAX_SAFE_INTEGER;
      }, 1000);
    } else if (!hasRunning && taskClockTimer !== null) {
      clearInterval(taskClockTimer);
      taskClockTimer = null;
    }
  },
  { immediate: true },
);

// Start/stop task output polling based on whether the active session has
// running background tasks. This mirrors the TUI's 1-second refresh.
watch(
  () => {
    const sid = rawState.activeSessionId;
    if (!sid) return { sid: undefined as string | undefined, hasRunning: false };
    const tasks = rawState.tasksBySession[sid] ?? [];
    return { sid, hasRunning: tasks.some((t) => t.status === 'running') };
  },
  ({ sid, hasRunning }, _prev, onCleanup) => {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    if (hasRunning && sid !== undefined) {
      startTaskOutputPolling(sid);
    } else if (sid !== undefined) {
      // All tasks finished — wait a beat to catch final output, then stop.
      cleanupTimer = setTimeout(() => {
        const tasks = rawState.tasksBySession[sid] ?? [];
        if (!tasks.some((t) => t.status === 'running')) {
          stopTaskOutputPolling();
        }
      }, 1500);
    } else {
      stopTaskOutputPolling();
    }
    onCleanup(() => {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    });
  },
  { deep: true, immediate: true },
);

const tasks = computed<TaskItem[]>(() => {
  // Touch the clock so a running task's elapsed time recomputes each tick.
  void taskClock.value;
  return activeAppTasks.value.map(toUiTask);
});

const swarms = computed<SwarmGroup[]>(() => buildSwarmGroups(activeAppTasks.value));

const goal = computed<AppGoal | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.goalBySession[sid] ?? null;
});

/** Current todo list of the active session (TodoList tool, latest write wins). */
const todos = computed<TodoView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return latestTodos(rawState.messagesBySession[sid] ?? []);
});

/** Live compaction state of the active session (present only while running). */
const compaction = computed<CompactionStatus | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.compactionBySession[sid] ?? null;
});

const connection = computed<ConnectionState>(() => rawState.connection);

const loading = computed<boolean>(() => rawState.loading);
const sessionLoading = computed<boolean>(() => rawState.sessionLoading);
const loadingMoreMessages = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? rawState.messagesLoadingMoreBySession[sid] ?? false : false;
});
const hasMoreMessages = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? rawState.messagesHasMoreBySession[sid] ?? false : false;
});
const loadMoreMessagesError = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? rawState.messagesLoadMoreErrorBySession[sid] ?? false : false;
});
const serverVersion = computed<string>(() => rawState.serverVersion);

const permission = computed<PermissionMode>(() => rawState.permission);
const thinking = computed<ThinkingLevel>(() => rawState.thinking);
const planMode = computed<boolean>(() => rawState.planMode);
const swarmMode = computed<boolean>(() => rawState.swarmMode);
const goalMode = computed<boolean>(() => rawState.goalMode);

const activationBadges = computed<ActivationBadges>(() => {
  const swarmCounts = countSwarmMembers(swarms.value);
  return {
    plan: rawState.planMode,
    goal: goal.value && goal.value.status !== 'complete'
      ? {
          status: goal.value.status,
          turnsUsed: goal.value.turnsUsed,
          elapsedMs: goal.value.wallClockMs,
        }
      : null,
    swarm: swarmCounts.total > 0 ? swarmCounts : null,
  };
});

/** Queued messages for the active session (text + attachment count for the
    composer strip — an image-only prompt would otherwise render as an empty
    string). */
const queued = computed<QueuedPromptView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.queuedBySession[sid] ?? []).map((q) => ({
    text: q.text,
    attachmentCount: q.attachments?.length ?? 0,
  }));
});

/** Pending warnings list */
const warnings = computed<AppWarning[]>(() => rawState.warnings);

/** Active session's pending questions mapped to UIQuestion[] */
const questions = computed<UIQuestion[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.questionsBySession[sid] ?? []).map(toUiQuestion);
});

/**
 * Pending approvals for the active session, rendered as standalone interrupt
 * cards at the end of the transcript (they do NOT need to match a loaded
 * tool_use). This is how the TUI / old web surface approvals.
 */
const pendingApprovals = computed<
  { approvalId: string; block: ApprovalBlock; agentName?: string }[]
>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.approvalsBySession[sid] ?? []).map((a) => ({
    approvalId: a.approvalId,
    block: buildApprovalBlock(a),
    agentName: (a as { agentName?: string }).agentName,
  }));
});

/**
 * Activity state for the active session.
 * Priority: awaiting-approval > awaiting-question > running > idle
 */
const activity = computed<ActivityState>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return 'idle';

  const approvals = rawState.approvalsBySession[sid] ?? [];
  if (approvals.length > 0) return 'awaiting-approval';

  const questionList = rawState.questionsBySession[sid] ?? [];
  if (questionList.length > 0) return 'awaiting-question';

  if (isSessionEffectivelyRunning(sid)) {
    return 'running';
  }

  return 'idle';
});

/** Git info for the active session from the daemon's fs:git_status response */
const gitInfo = computed<{ branch: string; ahead: number; behind: number } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return null;
  return { branch: gs.branch, ahead: gs.ahead, behind: gs.behind };
});

/** GitHub pull request for the active session's current branch. Null when
    unknown, not a GitHub repo, or the branch has no PR — the header hides it. */
const activePullRequest = computed<{ number: number; state: string; url: string } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.gitStatusBySession[sid]?.pullRequest ?? null;
});

/** Changed files for the active session, sorted by path */
const changes = computed<{ path: string; status: string }[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return [];
  return Object.entries(gs.entries)
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
});

/** Aggregate working-tree line stats (vs HEAD) for the active session's header
    diff counter. Null when no git status is loaded, so the header hides it. */
const gitDiffStats = computed<{ totalAdditions: number; totalDeletions: number } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return null;
  return { totalAdditions: gs.additions, totalDeletions: gs.deletions };
});

const status = computed<ConversationStatus>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  // Prefer real git branch from daemon; fall back to cwd basename
  const branch =
    gitInfo.value?.branch ??
    (activeSession ? activeSession.cwd.split('/').pop() ?? activeSession.cwd : 'main');
  // session.model is kept live by GET /status (on select/idle) and the WS
  // agent.status.updated event during a turn; fall back to the daemon default.
  // In the draft state (no active session) the user's draft pick wins, so the
  // composer dropdown reflects the selection before the session exists.
  const draftPick = activeSession === undefined ? draftModel.value : null;
  const rawModel =
    (activeSession?.model && activeSession.model.length > 0
      ? activeSession.model
      : draftPick ?? rawState.defaultModel) ?? '—';

  // Use the friendly displayName from the models list; fall back to stripping
  // the provider prefix (e.g. "moonshot/moonshot-v1-128k" → "moonshot-v1-128k").
  const matched = models.value.find((m) => m.id === rawModel || m.model === rawModel);
  const displayModel =
    matched?.displayName ||
    matched?.model ||
    (rawModel.includes('/') ? rawModel.split('/').pop()! : rawModel);

  return {
    model: displayModel,
    // Raw id for exact comparison in pickers (display name diverges from id).
    modelId: matched?.id ?? rawModel,
    ctxUsed: activeSession?.usage.contextTokens ?? 0,
    ctxMax: activeSession?.usage.contextLimit ?? 0,
    permission: rawState.permission,
    branch,
    cwd: activeSession?.cwd ?? '',
    isGitRepo: gitInfo.value !== null,
  };
});

/** Parsed unified-diff lines for the file selected in the ~/diff tab. */
const fileDiff = computed<DiffViewLine[]>(() => fileDiffLines.value);

/** Cumulative cost (USD) for the active session, from daemon usage. 0 if unknown. */
const sessionCost = computed<number>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  return activeSession?.usage.totalCostUsd ?? 0;
});

const authReady = computed<boolean>(() => rawState.authReady);
const defaultModel = computed<string | null>(() => rawState.defaultModel);
const managedProviderStatus = computed<string | null>(() => rawState.managedProviderStatus);
const config = computed<AppConfig | null>(() => rawState.config);

/** path → status map for quick badge lookup in the file tree */
const changesByPath = computed<Record<string, string>>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return {};
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return {};
  return { ...gs.entries };
});

// ---------------------------------------------------------------------------
// Workspace view-model
// ---------------------------------------------------------------------------

/**
 * The workspace id a session belongs to: prefer the daemon-provided
 * session.workspaceId; otherwise map by cwd (in derived/fallback mode the
 * workspace id IS the cwd).
 */
function workspaceIdForSession(s: { workspaceId?: string; cwd: string }): string {
  return rawState.workspaces.find((w) => w.root === s.cwd)?.id ?? s.workspaceId ?? s.cwd;
}

/**
 * Merge real (daemon) workspaces with workspaces DERIVED from the current
 * sessions' cwds. Each distinct cwd with no matching real workspace becomes one
 * derived workspace (id = root = cwd). This makes the switcher + grouping work
 * immediately off existing sessions until /workspaces ships.
 */
const mergedWorkspaces = computed<AppWorkspace[]>(() => {
  const hidden = new Set(rawState.hiddenWorkspaceRoots);
  const byRoot = new Map<string, AppWorkspace>();
  // Real workspaces win on root (unless the user removed them from the sidebar).
  for (const w of rawState.workspaces) {
    if (hidden.has(w.root)) continue;
    byRoot.set(w.root, { ...w });
  }
  // Derive from sessions for any cwd without a real workspace.
  for (const s of rawState.sessions) {
    const root = s.cwd;
    if (!root) continue;
    if (hidden.has(root)) continue; // removed from the sidebar — keep it hidden
    if (!byRoot.has(root)) {
      byRoot.set(root, {
        // Use the session's REAL daemon workspace_id (wd_<slug>_<hash>) so
        // createSession({ workspaceId }) is accepted; fall back to cwd only
        // when the daemon hasn't tagged the session yet.
        id: s.workspaceId ?? root,
        root,
        name: basename(root),
        isGitRepo: false,
        sessionCount: 0,
      });
    }
  }
  // Compute live session counts + a branch hint from the active session's git.
  const counts = new Map<string, number>();
  for (const s of rawState.sessions) {
    const wid = workspaceIdForSession(s);
    counts.set(wid, (counts.get(wid) ?? 0) + 1);
  }
  const activeGit = gitInfo.value;
  const activeRoot = rawState.sessions.find((s) => s.id === rawState.activeSessionId)?.cwd;

  // Order: real workspaces in listWorkspaces order, then derived workspaces
  // sorted by root path so the order is stable (not tied to session activity).
  const realRoots = rawState.workspaces.map((w) => w.root);
  const derivedRoots = [...byRoot.keys()].filter((r) => !realRoots.includes(r));
  derivedRoots.sort((a, b) => a.localeCompare(b));

  const result: AppWorkspace[] = [];
  for (const root of [...realRoots, ...derivedRoots]) {
    const w = byRoot.get(root)!;
    // Match count by either id or root (derived id === root). Once sessions
    // have loaded, trust the live local count (0 when no sessions remain) rather
    // than the daemon's sessionCount, which historically counted archived
    // sessions and would keep a workspace looking non-empty after its last
    // session was archived.
    const count = counts.get(w.id) ?? counts.get(w.root) ?? (rawState.loading ? w.sessionCount : 0);
    let branch = w.branch;
    if (!branch && activeGit && activeRoot === w.root) branch = activeGit.branch;
    result.push({ ...w, sessionCount: count, branch });
  }
  return result;
});

/** Sidebar-facing workspace list. */
const workspacesView = computed<WorkspaceView[]>(() =>
  mergedWorkspaces.value.map((w) => ({
    id: w.id,
    name: w.name,
    root: w.root,
    shortPath: shortenHome(w.root, rawState.fsHome),
    branch: w.branch,
    sessionCount: w.sessionCount,
  })),
);

/** The active workspace id, falling back to the first available workspace. */
const activeWorkspaceId = computed<string | null>(() => {
  const id = rawState.activeWorkspaceId;
  const list = mergedWorkspaces.value;
  if (id && list.some((w) => w.id === id)) return id;
  return list[0]?.id ?? null;
});

/** The active workspace as a sidebar view (or null when none). */
const visibleWorkspace = computed<WorkspaceView | null>(() => {
  const id = activeWorkspaceId.value;
  if (!id) return null;
  return workspacesView.value.find((w) => w.id === id) ?? null;
});

/**
 * All sessions for the sidebar (grouped by workspace via workspaceGroups).
 */
const sessionsForView = computed<Session[]>(() => {
  void sessionTimeClock.value;
  const visibleWorkspaceIds = new Set(workspacesView.value.map((w) => w.id));
  // Child ("side chat") sessions never appear in the main list — they live in
  // the side-chat panel only. Sessions under a removed (hidden) workspace are
  // excluded too, so this flat list matches what the grouped sidebar renders
  // and sidebar search can't resurrect sessions from a removed workspace.
  return rawState.sessions
    .filter((s) => !s.parentSessionId && visibleWorkspaceIds.has(workspaceIdForSession(s)))
    .map((s) => ({
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt, s.status),
      status: s.status,
      busy: isSessionEffectivelyRunning(s.id),
      lastPrompt: s.lastPrompt,
    }));
});

/** Per-workspace groups for the 'all workspaces' scope. */
const workspaceGroups = computed<WorkspaceGroup[]>(() => {
  void sessionTimeClock.value;
  const byId = new Map<string, Session[]>();
  for (const s of rawState.sessions.toSorted(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )) {
    if (s.parentSessionId) continue; // child sessions stay out of the list
    const wid = workspaceIdForSession(s);
    const view: Session = {
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt, s.status),
      status: s.status,
      busy: isSessionEffectivelyRunning(s.id),
      updatedAt: s.updatedAt,
    };
    const list = byId.get(wid) ?? [];
    list.push(view);
    byId.set(wid, list);
  }
  return workspacesView.value.map((w) => ({
    workspace: w,
    sessions: byId.get(w.id) ?? [],
  }));
});

/**
 * Per-session pending-attention count = pending approvals + pending questions.
 * For the active session this is live (driven by WS events). Other sessions
 * light up once the daemon ships Session.pending_attention; until then their
 * counts are derived from whatever approvals/questions we've already seen.
 */
const attentionBySession = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const [sid, list] of Object.entries(rawState.approvalsBySession)) {
    if (list.length > 0) out[sid] = (out[sid] ?? 0) + list.length;
  }
  for (const [sid, list] of Object.entries(rawState.questionsBySession)) {
    if (list.length > 0) out[sid] = (out[sid] ?? 0) + list.length;
  }
  return out;
});

/**
 * Per-session pending counts split by KIND, so the sidebar can show distinct
 * coloured tags: one for "awaiting your answer" (askUserQuestion) and one for
 * "awaiting your approval" (permission request). The merged count above stays
 * for the workspace rail / dialogs that only need a single number.
 */
const pendingBySession = computed<Record<string, { approvals: number; questions: number }>>(() => {
  const out: Record<string, { approvals: number; questions: number }> = {};
  for (const [sid, list] of Object.entries(rawState.approvalsBySession)) {
    if (list.length > 0) (out[sid] ??= { approvals: 0, questions: 0 }).approvals = list.length;
  }
  for (const [sid, list] of Object.entries(rawState.questionsBySession)) {
    if (list.length > 0) (out[sid] ??= { approvals: 0, questions: 0 }).questions = list.length;
  }
  return out;
});

/** Per-session unread flag (a background turn finished, not yet opened). */
const unreadBySession = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {};
  for (const [sid, unread] of Object.entries(rawState.unreadBySession)) {
    if (unread) out[sid] = true;
  }
  return out;
});

/**
 * Per-workspace pending-attention count = sum of attentionBySession over the
 * sessions belonging to each workspace. Drives the rail's attention badge.
 */
const attentionByWorkspace = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  const perSession = attentionBySession.value;
  for (const s of rawState.sessions) {
    const count = perSession[s.id] ?? 0;
    if (count <= 0) continue;
    const wid = workspaceIdForSession(s);
    out[wid] = (out[wid] ?? 0) + count;
  }
  return out;
});

/** Recently-used roots for the add-workspace quick-pick (from /fs:home). */
const recentRoots = computed<string[]>(() => rawState.recentRoots);

/** Distinct cwd values from loaded sessions, most-recent first, deduped, max 8 */
const recentCwds = computed<string[]>(() => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of rawState.sessions) {
    const cwd = s.cwd;
    if (cwd && !seen.has(cwd)) {
      seen.add(cwd);
      result.push(cwd);
      if (result.length >= 8) break;
    }
  }
  return result;
});

/** Installed external apps the "Open in app" menu may offer for this host. */
const availableOpenInApps = computed<string[]>(() => rawState.availableOpenInApps);

// ---------------------------------------------------------------------------
// Per-session turn-end cleanup + queue auto-flush.
// Driven by the daemon's sessionStatusChanged → idle event (wired in
// connectEventsIfNeeded), NOT by the active-session `activity` computed: a
// watcher on `activity` only ever saw the ACTIVE session, so a session that
// finished in the background kept its in-flight flag forever — every later
// prompt to it was silently enqueued and never flushed.
// ---------------------------------------------------------------------------

function onSessionIdle(sid: string): void {
  // The turn finished — this session no longer has a prompt in flight.
  inFlightPromptSessions.delete(sid);
  rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
  // Drop any cached prompt_id so a later skill activation (which has no
  // prompt_id) doesn't accidentally reuse this stale id for :abort.
  if (rawState.promptIdBySession[sid] !== undefined) {
    const next = { ...rawState.promptIdBySession };
    delete next[sid];
    rawState.promptIdBySession = next;
  }

  // For the session on screen, refresh git status (edits the agent just made)
  // and runtime status (model/context usage may have changed this turn).
  if (sid === rawState.activeSessionId) {
    appearance.resetFastMoon();
    void loadGitStatus(sid);
    void refreshSessionStatus(sid);
  } else {
    // A background session just finished a turn the user hasn't seen — light up
    // its unread dot until they open it.
    rawState.unreadBySession = { ...rawState.unreadBySession, [sid]: true };
    saveUnreadToStorage(rawState.unreadBySession);
  }

  // Browser notification when the user isn't watching this session.
  notification.maybeNotifyCompletion(sid, {
    isActiveAndVisible:
      sid === rawState.activeSessionId &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible',
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
    onClick: () => {
      void selectSession(sid);
    },
  });

  const queue = rawState.queuedBySession[sid] ?? [];
  if (queue.length === 0) return;

  const [next, ...rest] = queue;
  rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: rest };
  // Flush the first queued message; on failure put it back at the head so a
  // transient error doesn't silently drop the prompt.
  if (next !== undefined) {
    void submitPromptInternal(sid, next.text, next.attachments).then((ok) => {
      if (!ok) {
        const current = rawState.queuedBySession[sid] ?? [];
        rawState.queuedBySession = {
          ...rawState.queuedBySession,
          [sid]: [next, ...current],
        };
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Load + parse the unified diff for one changed file in the active session,
 * storing the result for the ~/diff line-by-line view. Defensive: on error
 * (or no active session) it leaves the diff empty but still records the path
 * so the panel opens with an empty state instead of silently doing nothing.
 */
async function loadFileDiff(path: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  selectedDiffPath.value = path;
  fileDiffLines.value = [];
  fileDiffLoading.value = true;
  try {
    const api = getKimiWebApi();
    const result = await api.getFileDiff(sid, path);
    // Guard against a stale response when the user tapped another file.
    if (selectedDiffPath.value !== path) return;
    fileDiffLines.value = parseDiff(result.diff);
  } catch (err) {
    // A single file's diff failing (a new/untracked/binary/deleted file the
    // daemon can't diff) is LOCAL to this pane, not a session-level fault — the
    // DiffView already shows a graceful "no diff" state when the lines are
    // empty. Surfacing it as a global "kimi server api" error toast on a routine
    // file click is disproportionate, so log it for the trace export instead.
    if (selectedDiffPath.value === path) fileDiffLines.value = [];
    console.warn('[loadFileDiff] diff unavailable for', path, err);
  } finally {
    if (selectedDiffPath.value === path) fileDiffLoading.value = false;
  }
}

/** Close the ~/diff line-by-line view and return to the changed-file list. */
function clearFileDiff(): void {
  selectedDiffPath.value = null;
  fileDiffLines.value = [];
  fileDiffLoading.value = false;
}

/** Load git status for a session — defensive, never throws */
async function loadGitStatus(sessionId: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    const result = await api.getGitStatus(sessionId);
    rawState.gitStatusBySession = {
      ...rawState.gitStatusBySession,
      [sessionId]: result,
    };
  } catch {
    // Stale/old sessions may 404 — leave undefined, no crash
  }
}

/** Fetch auth readiness from GET /api/v1/auth. Defensive — never throws. */
async function checkAuth(): Promise<void> {
  try {
    const api = getKimiWebApi();
    const result = await api.getAuth();
    rawState.authReady = result.ready;
    rawState.defaultModel = result.defaultModel;
    rawState.managedProviderStatus = result.managedProvider?.status ?? null;
  } catch {
    // Daemon may not have this endpoint yet; leave defaults (authReady: false)
  }
}

/** Fetch global config from GET /api/v1/config. Defensive — never throws. */
async function loadConfig(): Promise<void> {
  try {
    const api = getKimiWebApi();
    rawState.config = await api.getConfig();
  } catch {
    // Daemon may not have this endpoint yet; leave null
  }
}

/** Update global config via POST /api/v1/config. */
async function updateConfig(patch: Partial<AppConfig>): Promise<boolean> {
  try {
    const api = getKimiWebApi();
    const next = await api.setConfig(patch);
    rawState.config = next;
    rawState.defaultModel = next.defaultModel ?? null;
    return true;
  } catch (err) {
    pushOperationFailure('setConfig', err);
    return false;
  }
}

// False until the very first load() settles (success OR failure). Gates the
// global connecting-splash so a page refresh doesn't flash a half-empty app.
const initialized = ref(false);

// Backend max page size for GET /sessions. Bigger pages mean fewer round-trips
// when draining the full session list.
const SESSION_PAGE_SIZE = 100;

/** Drain every page of sessions, newest first. A single global walk (instead of
 *  per-workspace) so sessions whose cwd is not a registered workspace root are
 *  still reachable after a refresh. */
async function listAllSessionsGlobal(): Promise<AppSession[]> {
  const api = getKimiWebApi();
  const items: AppSession[] = [];
  let beforeId: string | undefined;
  for (;;) {
    const page = await api.listSessions({ pageSize: SESSION_PAGE_SIZE, beforeId });
    items.push(...page.items);
    if (!page.hasMore || page.items.length === 0) break;
    beforeId = page.items[page.items.length - 1]!.id;
  }
  return items;
}

async function load(): Promise<void> {
  rawState.loading = true;
  try {
    const api = getKimiWebApi();
    // Parallel: health + meta + models
    await Promise.all([
      api.getHealth().catch(() => null),
      api.getMeta().then((m) => {
        rawState.serverVersion = m.serverVersion;
        rawState.availableOpenInApps = m.openInApps;
      }).catch(() => null),
      loadModels(),
    ]);

    // Check auth readiness and global config (separate calls — defensive)
    await checkAuth();
    await loadConfig();

    // Drain every session via a single global walk so sessions whose cwd is not
    // a registered workspace root are still reachable after a refresh.
    const sessions = await listAllSessionsGlobal().catch(() => [] as AppSession[]);
    rawState.sessions = sessions;

    // Load workspaces (real if available, else derived from session cwds).
    await loadWorkspaces();

    // First load: pick the workspace of the most-recent session, unless the
    // user already has a persisted active workspace that still exists.
    const mostRecent = sessions[0];
    const persisted = rawState.activeWorkspaceId;
    const persistedStillExists =
      persisted !== null && mergedWorkspaces.value.some((w) => w.id === persisted);
    if (!persistedStillExists && mostRecent) {
      selectWorkspace(workspaceIdForSession(mostRecent));
    }

    // URL deep link (/sessions/<id>) takes priority over auto-select. The
    // session may live outside the loaded pages (e.g. archived) — fetch it then.
    // selectSession syncs the active workspace off the (now present) entry.
    bindSessionRoute();
    const urlSessionId =
      typeof window !== 'undefined' ? readSessionIdFromLocation(window.location) : undefined;
    if (!rawState.activeSessionId && urlSessionId !== undefined) {
      const available =
        rawState.sessions.some((s) => s.id === urlSessionId) ||
        (await fetchSessionIntoList(urlSessionId));
      if (available) {
        await selectSession(urlSessionId, { urlMode: 'replace' });
      }
    }

    // Auto-select first session if none selected (also the fallback for a dead
    // deep link — 'replace' rewrites the URL to the session actually shown).
    if (!rawState.activeSessionId && sessions.length > 0) {
      await selectSession(sessions[0]!.id, { urlMode: 'replace' });
    }
  } catch (err) {
    pushOperationFailure('load', err);
    // Do not re-throw — app stays mounted with empty sessions
  } finally {
    rawState.loading = false;
    initialized.value = true;
  }
}

/** Load workspaces from the daemon (falls back to derived in mergedWorkspaces). */
async function loadWorkspaces(): Promise<void> {
  try {
    const api = getKimiWebApi();
    const [list, home] = await Promise.all([
      api.listWorkspaces().catch(() => [] as AppWorkspace[]),
      api.getFsHome().catch(() => ({ home: '', recentRoots: [] })),
    ]);
    rawState.workspaces = list;
    rawState.fsHome = home.home || null;
    rawState.recentRoots = home.recentRoots;
  } catch {
    // Defensive — derived workspaces still work off the loaded sessions.
  }
}

/** Set the active workspace and persist it. */
function selectWorkspace(id: string): void {
  rawState.activeWorkspaceId = id;
  saveActiveWorkspaceToStorage(id);
}

/** Open a workspace in the main pane: clear the active session when the
 *  workspace is empty so the centred composer is shown; otherwise activate
 *  the most recent session in that workspace. */
function openWorkspace(id: string): void {
  selectWorkspace(id);
  const sessionsInWs = rawState.sessions.filter((s) => workspaceIdForSession(s) === id);
  if (sessionsInWs.length > 0) {
    const mostRecent = sessionsInWs[0];
    if (mostRecent && mostRecent.id !== rawState.activeSessionId) {
      // One user action (clicking the workspace) = one history entry.
      void selectSession(mostRecent.id);
    }
  } else {
    rawState.activeSessionId = undefined;
    writeSessionUrl(undefined, 'push');
  }
}

/** Upsert a workspace: preserve existing order when updating; prepend only
 *  for truly new workspaces. */
function upsertWorkspacePreserveOrder(workspace: AppWorkspace): void {
  // Re-adding a path the user previously removed should bring it back.
  if (rawState.hiddenWorkspaceRoots.includes(workspace.root)) {
    rawState.hiddenWorkspaceRoots = rawState.hiddenWorkspaceRoots.filter((r) => r !== workspace.root);
    saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
  }
  const index = rawState.workspaces.findIndex(
    (w) => w.id === workspace.id || w.root === workspace.root,
  );
  if (index === -1) {
    rawState.workspaces = [workspace, ...rawState.workspaces];
    return;
  }
  const next = [...rawState.workspaces];
  next[index] = workspace;
  rawState.workspaces = next;
}

type WorkspaceLifecycleEvent =
  | { type: 'workspaceCreated'; workspace: AppWorkspace }
  | { type: 'workspaceUpdated'; workspace: AppWorkspace }
  | { type: 'workspaceDeleted'; workspaceId: string; root: string };

/** Apply a workspace lifecycle event broadcast by the daemon (multi-client sync).
 *  Workspaces live outside the reducer in rawState, so these events are handled
 *  here instead of in reduceAppEvent. */
function applyWorkspaceEvent(event: WorkspaceLifecycleEvent): void {
  if (event.type === 'workspaceCreated' || event.type === 'workspaceUpdated') {
    upsertWorkspacePreserveOrder(event.workspace);
    return;
  }
  // workspaceDeleted — mirror the local deleteWorkspace so a removal initiated
  // by another client stays hidden even though its surviving sessions would
  // otherwise re-derive it in mergedWorkspaces.
  const root =
    rawState.workspaces.find((w) => w.id === event.workspaceId)?.root ?? event.root;
  if (root && !rawState.hiddenWorkspaceRoots.includes(root)) {
    rawState.hiddenWorkspaceRoots = [...rawState.hiddenWorkspaceRoots, root];
    saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
  }
  rawState.workspaces = rawState.workspaces.filter(
    (w) => w.id !== event.workspaceId && w.root !== root,
  );
  const removingActiveWorkspace =
    rawState.activeWorkspaceId === event.workspaceId || rawState.activeWorkspaceId === root;
  if (removingActiveWorkspace) {
    const nextWorkspace = mergedWorkspaces.value[0]?.id ?? null;
    rawState.activeWorkspaceId = nextWorkspace;
    if (nextWorkspace) saveActiveWorkspaceToStorage(nextWorkspace);
    else {
      try {
        safeRemove(ACTIVE_WORKSPACE_KEY);
      } catch {
        // ignore
      }
    }
    rawState.activeSessionId = undefined;
    rawState.sessionLoading = false;
    clearFileDiff();
    writeSessionUrl(undefined, 'replace');
  }
}

/** Clear the active session without creating a new one. */
function clearActiveSession(): void {
  rawState.activeSessionId = undefined;
  writeSessionUrl(undefined, 'push');
}

/** Enter the "new session draft" state for a workspace: select it, clear the
 *  active session, and show the onboarding composer. No backend session is
 *  created until the user sends the first message. */
function openWorkspaceDraft(workspaceId: string): void {
  selectWorkspace(workspaceId);
  clearActiveSession();
  clearFileDiff();
}

/**
 * Create a session in a workspace — the one-click path (no cwd typing).
 * Register/touch the workspace first when the daemon supports it; if that
 * fails, fall back to the legacy cwd-only create path.
 */
async function createSessionInWorkspace(workspaceId: string): Promise<AppSession | undefined> {
  const ws = mergedWorkspaces.value.find((w) => w.id === workspaceId);
  if (!ws) return undefined;
  try {
    const api = getKimiWebApi();
    let workspaceIdForCreate: string | undefined;
    let cwdForCreate = ws.root;
    try {
      const registered = await api.addWorkspace({ root: ws.root });
      workspaceIdForCreate = registered.id;
      cwdForCreate = registered.root;
      upsertWorkspacePreserveOrder(registered);
    } catch {
      // Older daemons may not have /workspaces. In that mode, sending a local
      // path-like workspace id as workspace_id would fail validation, so use
      // metadata.cwd only.
    }
    const session = await api.createSession({ workspaceId: workspaceIdForCreate, cwd: cwdForCreate });
    rawState.sessions = [session, ...rawState.sessions.filter((s) => s.id !== session.id)];
    selectWorkspace(session.workspaceId ?? workspaceIdForCreate ?? workspaceId);
    // Locally created sessions start empty; trust that so the empty-composer
    // renders immediately instead of flashing a loading state.
    sessionsKnownEmpty.add(session.id);
    await selectSession(session.id);
    return session;
  } catch (err) {
    pushOperationFailure('createSessionInWorkspace', err);
    return undefined;
  }
}

/**
 * Create a session and immediately submit the first prompt.
 * This is the unified path when there is no active session (e.g. after
 * clicking "+" or in an empty workspace).
 */
async function startSessionAndSendPrompt(
  workspaceId: string,
  text: string,
  attachments?: PromptAttachment[],
): Promise<void> {
  const ws = mergedWorkspaces.value.find((w) => w.id === workspaceId);
  if (!ws) return;
  try {
    const api = getKimiWebApi();
    let workspaceIdForCreate: string | undefined;
    let cwdForCreate = ws.root;
    try {
      const registered = await api.addWorkspace({ root: ws.root });
      workspaceIdForCreate = registered.id;
      cwdForCreate = registered.root;
      upsertWorkspacePreserveOrder(registered);
    } catch {
      // Older daemons may not have /workspaces.
    }
    const draftPick = draftModel.value ?? undefined;
    const session = await api.createSession({
      workspaceId: workspaceIdForCreate,
      cwd: cwdForCreate,
      model: draftPick,
    });
    draftModel.value = null; // applied — the next draft starts from the default
    // The create echo may return model as '' (same daemon quirk as /profile);
    // keep the user's pick so the status line doesn't snap back to the default.
    const created =
      draftPick !== undefined && (!session.model || session.model.length === 0)
        ? { ...session, model: draftPick }
        : session;
    rawState.sessions = [created, ...rawState.sessions.filter((s) => s.id !== session.id)];
    selectWorkspace(session.workspaceId ?? workspaceIdForCreate ?? workspaceId);
    // NOTE: do NOT mark this session known-empty. Unlike "open a new empty
    // session" (createSession), here we immediately send a prompt: keeping
    // sessionLoading=true through the snapshot avoids flashing the empty-session
    // composer before the optimistic user message lands. selectSession resolves,
    // then submitPromptInternal adds the user turn synchronously (no await in
    // between), so the view goes loading → message with no empty-composer frame.
    await selectSession(session.id);
    await submitPromptInternal(session.id, text, attachments);
  } catch (err) {
    pushOperationFailure('startSessionAndSendPrompt', err);
  }
}

/**
 * Add a workspace by folder path. Tries the daemon registry; on failure (or in
 * fallback mode) creates a locally-derived workspace from the path and
 * remembers it, then selects it.
 */
async function addWorkspaceByPath(root: string): Promise<void> {
  const trimmed = root.trim();
  if (!trimmed) return;
  const api = getKimiWebApi();
  try {
    const ws = await api.addWorkspace({ root: trimmed });
    upsertWorkspacePreserveOrder(ws);
    openWorkspaceDraft(ws.id);
  } catch {
    // Fallback: remember a derived workspace locally (id = root = path).
    const existing = rawState.workspaces.find((w) => w.root === trimmed);
    if (!existing) {
      rawState.workspaces = [
        {
          id: trimmed,
          root: trimmed,
          name: basename(trimmed),
          isGitRepo: false,
          sessionCount: 0,
        },
        ...rawState.workspaces,
      ];
    }
    openWorkspaceDraft(trimmed);
  }
}

/**
 * Browse subdirectories under `path` (defaults to the daemon $HOME). Used by the
 * add-workspace folder browser. Defensive: returns an empty path on error so
 * the dialog can fall back to the paste-path field.
 */
async function browseFs(path?: string): Promise<import('../api/types').FsBrowseResult> {
  try {
    const api = getKimiWebApi();
    return await api.browseFs(path);
  } catch {
    return { path: '', parent: null, entries: [] };
  }
}

/** Start directory + recently-used roots for the folder browser. */
async function getFsHome(): Promise<{ home: string; recentRoots: string[] }> {
  try {
    const api = getKimiWebApi();
    return await api.getFsHome();
  } catch {
    return { home: '', recentRoots: [] };
  }
}

// ---------------------------------------------------------------------------
// URL ↔ session binding (no router): '/' ↔ /sessions/<id>
// urlMode semantics: 'push' = user navigation (new history entry); 'replace' =
// programmatic/auto selection (first load, fallback after delete); 'none' =
// popstate-driven (the URL is already correct — writing it again would loop).
// ---------------------------------------------------------------------------

function writeSessionUrl(sessionId: string | undefined, mode: SessionUrlMode): void {
  if (mode === 'none') return;
  if (typeof window === 'undefined' || !window.history) return;
  const target = sessionUrl(sessionId);
  if (window.location.pathname === target) return;
  try {
    if (mode === 'push') window.history.pushState(null, '', target);
    else window.history.replaceState(null, '', target);
  } catch {
    // history API unavailable (e.g. sandboxed iframe) — URL sync is best-effort
  }
}

/** Fetch a session that is not in the loaded list (deep link beyond the first
    page) and append it. Returns false when the daemon doesn't know it. */
async function fetchSessionIntoList(sessionId: string): Promise<boolean> {
  try {
    const session = await getKimiWebApi().getSession(sessionId);
    if (!rawState.sessions.some((s) => s.id === session.id)) {
      // Append, not prepend: the list is recency-ordered and a deep-linked old
      // session shouldn't displace the most-recent ones at the top.
      rawState.sessions = [...rawState.sessions, session];
    }
    return true;
  } catch {
    return false;
  }
}

function onSessionRoutePopState(): void {
  const id = readSessionIdFromLocation(window.location);
  if (id === undefined) {
    // Back/forward landed on '/' — no active session.
    rawState.activeSessionId = undefined;
    return;
  }
  if (id === rawState.activeSessionId) return;
  if (rawState.sessions.some((s) => s.id === id)) {
    void selectSession(id, { urlMode: 'none' });
    return;
  }
  // A history entry can point at a session that has since been deleted (or one
  // outside the loaded page): try to fetch it; on failure fall back to the most
  // recent session and FIX the URL so the bad entry doesn't stick around.
  void (async () => {
    if (await fetchSessionIntoList(id)) {
      await selectSession(id, { urlMode: 'none' });
      return;
    }
    const next = rawState.sessions[0];
    if (next) {
      await selectSession(next.id, { urlMode: 'replace' });
    } else {
      rawState.activeSessionId = undefined;
      writeSessionUrl(undefined, 'replace');
    }
  })();
}

let sessionRouteBound = false;
function bindSessionRoute(): void {
  if (sessionRouteBound || typeof window === 'undefined') return;
  sessionRouteBound = true;
  window.addEventListener('popstate', onSessionRoutePopState);
}

async function selectSession(
  sessionId: string,
  opts?: { urlMode?: SessionUrlMode },
): Promise<void> {
  const messagesLoaded = hasLoadedMessages(sessionId);
  // Only sessions created locally in this client are trusted to be empty.
  // The daemon-reported messageCount can be stale for old sessions, so relying
  // on it causes the empty-composer to flash before the real snapshot arrives.
  // A locally created session has no history to load: show the empty composer
  // immediately by skipping the `sessionLoading` flag (no flash), while the
  // snapshot still loads in the background like any other first open.
  const knownEmpty = !messagesLoaded && sessionsKnownEmpty.has(sessionId);
  // Single-use: after this select resolves the session is no longer "known empty".
  sessionsKnownEmpty.delete(sessionId);
  try {
    // Write the URL synchronously (before any await) so rapid clicks lay down
    // history entries in click order.
    writeSessionUrl(sessionId, opts?.urlMode ?? 'push');
    rawState.sessionLoading = !messagesLoaded && !knownEmpty;
    rawState.activeSessionId = sessionId;
    appearance.resetFastMoon();
    // Opening a session clears its unread dot.
    if (rawState.unreadBySession[sessionId]) {
      rawState.unreadBySession = { ...rawState.unreadBySession, [sessionId]: false };
      saveUnreadToStorage(rawState.unreadBySession);
    }
    // A diff belongs to the session it was loaded from — drop it on switch.
    clearFileDiff();

    // NOTE: persisted sessions are directly promptable on the current daemon —
    // selecting one and sending a message just works, no re-activation needed.

    // Keep the active workspace in sync with the selected session.
    const selected = rawState.sessions.find((s) => s.id === sessionId);
    if (selected) {
      const wid = workspaceIdForSession(selected);
      if (rawState.activeWorkspaceId !== wid) selectWorkspace(wid);
    }

    if (!messagesLoaded) {
      // First open: full snapshot → seed → subscribe(asOfSeq).
      const result = await syncSessionFromSnapshot(sessionId);
      if (result === 'not-found') return;
    } else {
      // Re-open: resume from the tracked cursor; the daemon replays any
      // missed durable events (or answers resync_required → snapshot).
      subscribeToSessionEvents(sessionId);
    }

    // Refresh sidecars AFTER the snapshot settles so status/usage updates
    // aren't overwritten by syncSessionFromSnapshot.
    refreshSessionSidecars(sessionId);
  } catch (err) {
    pushOperationFailure('selectSession', err, { sessionId });
  } finally {
    if (rawState.activeSessionId === sessionId) {
      rawState.sessionLoading = false;
    }
  }
}

async function createSession(cwd: string, opts?: { title?: string; model?: string }): Promise<void> {
  try {
    const api = getKimiWebApi();
    const session = await api.createSession({ cwd, title: opts?.title, model: opts?.model });
    rawState.sessions = [session, ...rawState.sessions.filter((s) => s.id !== session.id)];
    // Locally created sessions start empty; trust that so the empty-composer
    // renders immediately instead of flashing a loading state.
    sessionsKnownEmpty.add(session.id);
    await selectSession(session.id);
  } catch (err) {
    pushOperationFailure('createSession', err);
  }
}

/** Internal: submit a prompt to a specific session, bypassing the queue check.
    Returns true when the daemon accepted the prompt. */
async function submitPromptInternal(sid: string, text: string, attachments?: PromptAttachment[]): Promise<boolean> {
  // Mark this session as having a prompt in flight BEFORE any await, so a racing
  // sendPrompt sees it and enqueues. Cleared when activity returns to idle.
  inFlightPromptSessions.add(sid);
  rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: true };
  const tempId = nextOptimisticMsgId();
  try {
    const api = getKimiWebApi();
    const content: import('../api/types').AppMessageContent[] = [];
    if (text) content.push({ type: 'text', text });
    for (const att of attachments ?? []) {
      if (att.kind === 'video') content.push({ type: 'video', source: { kind: 'file', fileId: att.fileId } });
      else content.push({ type: 'image', source: { kind: 'file', fileId: att.fileId } });
    }
    if (content.length === 0) {
      inFlightPromptSessions.delete(sid);
      rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
      return false;
    }

    // OPTIMISTICALLY add the user message to local state BEFORE awaiting the
    // submit.  The real daemon does NOT emit a user-message event over WS, so
    // without this the user's own text never appears in the transcript.
    const optimisticMsg: AppMessage = {
      id: tempId,
      sessionId: sid,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      metadata: { 'kimiWeb.optimisticUserMessage': true },
    };
    const existingMessages = rawState.messagesBySession[sid] ?? [];
    rawState.messagesBySession = {
      ...rawState.messagesBySession,
      [sid]: [...existingMessages, optimisticMsg],
    };

    // The daemon now requires `model` + `thinking` on every prompt. Resolve the
    // model from the session (falls back to the daemon's default_model) and the
    // thinking level from the user's setting.
    const promptSession = rawState.sessions.find((s) => s.id === sid);
    const model =
      (promptSession?.model && promptSession.model.length > 0
        ? promptSession.model
        : rawState.defaultModel) ?? undefined;

    if (rawState.goalMode && text) {
      try {
        await api.updateSession(sid, { goalObjective: text.trim() });
      } catch (err) {
        pushOperationFailure('createGoal', err, { sessionId: sid });
        inFlightPromptSessions.delete(sid);
        rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
        const msgs = rawState.messagesBySession[sid] ?? [];
        if (msgs.some((m) => m.id === tempId)) {
          rawState.messagesBySession = {
            ...rawState.messagesBySession,
            [sid]: msgs.filter((m) => m.id !== tempId),
          };
        }
        return false;
      }
    }

    const result = await api.submitPrompt(sid, {
      content,
      model,
      thinking: rawState.thinking,
      permissionMode: rawState.permission,
      planMode: rawState.planMode,
      swarmMode: rawState.swarmMode,
    });

    if (rawState.goalMode) {
      rawState.goalMode = false;
      saveGoalModeToStorage(false);
    }

    // Authoritative prompt_id for :abort — race-free (the projector binding can
    // lose to a fast turn.started and synthesize a `pr_…` id the daemon rejects).
    rawState.promptIdBySession = { ...rawState.promptIdBySession, [sid]: result.promptId };

    // Reconcile without changing the id: ChatPane keys user turns by message id,
    // so replacing msg_opt_* with userMessageId remounts the bubble and flickers.
    // If a daemon/stub later echoes the user message, the reducer merges it into
    // this optimistic entry instead of appending a duplicate.
    const msgs = rawState.messagesBySession[sid] ?? [];
    const idx = msgs.findIndex((m) => m.id === tempId);
    if (idx !== -1) {
      const updated = [...msgs];
      updated[idx] = { ...updated[idx]!, promptId: updated[idx]!.promptId ?? result.promptId };
      rawState.messagesBySession = { ...rawState.messagesBySession, [sid]: updated };
    }

    // Bind the real daemon prompt_id into the event projector so the upcoming
    // turn.started uses it (instead of synthesizing a random one). This is what
    // makes Stop work on the real daemon: session.currentPromptId then matches
    // the prompt_id the REST :abort endpoint expects.
    eventConn?.bindNextPromptId(sid, result.promptId);

    // NOTE: we no longer set a local auto-title here. The daemon generates a
    // smarter title from the first prompt and announces it via
    // session.meta.updated (projected to sessionMetaUpdated). PATCHing a title
    // locally would mark the session isCustomTitle=true and SUPPRESS the
    // daemon's auto-title, so we let the daemon own it.
    return true;
  } catch (err) {
    // Submit failed — clear the in-flight flag so the next prompt isn't stuck
    // queued forever (turn.ended will never arrive), and roll back the
    // optimistic user message so the transcript doesn't show a delivered-
    // looking message the daemon never received.
    inFlightPromptSessions.delete(sid);
    rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
    const msgs = rawState.messagesBySession[sid] ?? [];
    if (msgs.some((m) => m.id === tempId)) {
      rawState.messagesBySession = {
        ...rawState.messagesBySession,
        [sid]: msgs.filter((m) => m.id !== tempId),
      };
    }
    pushOperationFailure('sendPrompt', err, { sessionId: sid });
    return false;
  }
}

async function sendPrompt(text: string, attachments?: PromptAttachment[]): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;

  // If the session is not idle OR a prompt is already in flight (submitted but
  // the WS turn.started hasn't flipped activity to 'running' yet), enqueue
  // instead of submitting directly. Gating on inFlightPromptSessions closes the
  // window where two rapid prompts would both submit and race.
  if (activity.value !== 'idle' || inFlightPromptSessions.has(sid)) {
    enqueue(text, attachments);
    return;
  }

  await submitPromptInternal(sid, text, attachments);
}

/**
 * steerPrompt() — TUI ctrl+s parity: merge any locally queued prompts with the
 * live composer text and inject the result into the RUNNING turn instead of
 * waiting for it to finish. Two-step against the daemon: submit (parks the
 * prompt behind the active one) then POST /prompts:steer. Falls back to a
 * normal send when the session is idle.
 */
async function steerPrompt(text: string, attachments?: PromptAttachment[]): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;

  // Merge queued texts (oldest first) + the live text, like the TUI does.
  const queue = rawState.queuedBySession[sid] ?? [];
  const parts: string[] = [];
  const mergedAttachments: PromptAttachment[] = [];
  for (const q of queue) {
    const trimmed = q.text.trim();
    if (trimmed) parts.push(trimmed);
    if (q.attachments?.length) mergedAttachments.push(...q.attachments);
  }
  const live = text.trim();
  if (live) parts.push(live);
  if (attachments?.length) mergedAttachments.push(...attachments);
  if (parts.length === 0 && mergedAttachments.length === 0) return;
  if (queue.length > 0) {
    rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: [] };
  }
  const merged = parts.join('\n\n');

  // Idle and nothing in flight — there is no turn to steer into; normal send.
  if (activity.value === 'idle' && !inFlightPromptSessions.has(sid)) {
    await submitPromptInternal(sid, merged, mergedAttachments);
    return;
  }

  // Optimistic transcript echo (the daemon emits no user-message WS event).
  const content: import('../api/types').AppMessageContent[] = [];
  if (merged) content.push({ type: 'text', text: merged });
  for (const att of mergedAttachments) {
    if (att.kind === 'video') content.push({ type: 'video', source: { kind: 'file', fileId: att.fileId } });
    else content.push({ type: 'image', source: { kind: 'file', fileId: att.fileId } });
  }
  const tempId = nextOptimisticMsgId();
  const optimisticMsg: AppMessage = {
    id: tempId,
    sessionId: sid,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    metadata: { 'kimiWeb.optimisticUserMessage': true },
  };
  rawState.messagesBySession = {
    ...rawState.messagesBySession,
    [sid]: [...(rawState.messagesBySession[sid] ?? []), optimisticMsg],
  };

  try {
    const api = getKimiWebApi();
    const promptSession = rawState.sessions.find((s) => s.id === sid);
    const model =
      (promptSession?.model && promptSession.model.length > 0
        ? promptSession.model
        : rawState.defaultModel) ?? undefined;
    const result = await api.submitPrompt(sid, {
      content,
      model,
      thinking: rawState.thinking,
      permissionMode: rawState.permission,
      planMode: rawState.planMode,
      swarmMode: rawState.swarmMode,
    });

    // Stamp the real prompt_id onto the optimistic echo. Unlike a normal send,
    // a steered prompt IS echoed back by the daemon as a messageCreated user
    // event; matching that echo by prompt_id (instead of content) is what keeps
    // an image steer from rendering two user bubbles.
    const echoMsgs = rawState.messagesBySession[sid] ?? [];
    const echoIdx = echoMsgs.findIndex((m) => m.id === tempId);
    if (echoIdx !== -1) {
      const updated = [...echoMsgs];
      updated[echoIdx] = { ...updated[echoIdx]!, promptId: updated[echoIdx]!.promptId ?? result.promptId };
      rawState.messagesBySession = { ...rawState.messagesBySession, [sid]: updated };
    }

    if (result.status !== 'queued') {
      // The turn ended while the user was typing — the prompt started a turn
      // of its own. Wire it up like a regular send so :abort keeps working.
      rawState.promptIdBySession = { ...rawState.promptIdBySession, [sid]: result.promptId };
      eventConn?.bindNextPromptId(sid, result.promptId);
      return;
    }

    try {
      await api.steerPrompts(sid, [result.promptId]);
    } catch {
      // The active turn finished between submit and steer — the daemon starts
      // the parked prompt as its own turn. Nothing to roll back.
    }
  } catch (err) {
    // Submit failed: drop the optimistic echo so the transcript doesn't show
    // a delivered-looking message the daemon never received.
    const msgs = rawState.messagesBySession[sid] ?? [];
    rawState.messagesBySession = {
      ...rawState.messagesBySession,
      [sid]: msgs.filter((m) => m.id !== tempId),
    };
    pushOperationFailure('steer', err, { sessionId: sid });
  }
}

/**
 * Upload an image file to the daemon's /api/v1/files endpoint.
 * Returns { fileId, name, mediaType } on success, or null on error (warning added to state).
 */
async function uploadImage(file: Blob, name?: string): Promise<{ fileId: string; name: string; mediaType: string } | null> {
  try {
    const api = getKimiWebApi();
    const result = await api.uploadFile({ file, name });
    return { fileId: result.id, name: result.name, mediaType: result.mediaType };
  } catch (err) {
    pushOperationFailure('uploadImage', err);
    return null;
  }
}

/** Enqueue a message for the active session; flushed when activity returns to idle */
function enqueue(text: string, attachments?: PromptAttachment[]): void {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  const current = rawState.queuedBySession[sid] ?? [];
  rawState.queuedBySession = {
    ...rawState.queuedBySession,
    [sid]: [...current, { text, attachments }],
  };
}

async function abortCurrentPrompt(): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  const session = rawState.sessions.find((s) => s.id === sid);

  // 1. Authoritative id captured at submit time.
  let promptId = rawState.promptIdBySession[sid];

  // 2. Fallback to projector-derived id only when it is a real daemon prompt_id
  //    (synthetic `pr_...` ids are rejected by the daemon).
  if (promptId === undefined) {
    const candidate = session?.currentPromptId;
    if (candidate?.startsWith('prompt_')) {
      promptId = candidate;
    }
  }

  const api = getKimiWebApi();

  // 3. If we have a real id, try the per-prompt abort first. On 40402 fall back
  //    to session-level abort (the daemon may have restarted or the id is stale).
  if (promptId !== undefined) {
    try {
      await api.abortPrompt(sid, promptId);
      return;
    } catch (err) {
      if (isDaemonApiError(err) && err.code === PROMPT_NOT_FOUND_CODE) {
        // Stale id — try the session-level fallback below.
      } else {
        pushOperationFailure('abortCurrentPrompt', err, { sessionId: sid });
        return;
      }
    }
  }

  // 4. No real id, or the prompt id is no longer recognized: cancel whatever
  //    is running in the session (including skill activations).
  try {
    await api.abortSession(sid);
  } catch (err) {
    pushOperationFailure('abortCurrentPrompt', err, { sessionId: sid });
  }
}

async function respondApproval(
  approvalId: string,
  response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string },
): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    const api = getKimiWebApi();
    const fullResponse: ApprovalResponse = {
      decision: response.decision,
      scope: response.scope,
      feedback: response.feedback,
    };
    await api.respondApproval(sid, approvalId, fullResponse);
    // Remove from local approvals immediately (WS event will confirm)
    const list = rawState.approvalsBySession[sid] ?? [];
    rawState.approvalsBySession = {
      ...rawState.approvalsBySession,
      [sid]: list.filter((a) => a.approvalId !== approvalId),
    };
  } catch (err) {
    pushOperationFailure('respondApproval', err, { sessionId: sid });
  }
}

async function respondQuestion(
  questionId: string,
  response: QuestionResponse,
): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    const api = getKimiWebApi();
    await api.respondQuestion(sid, questionId, response);
    const list = rawState.questionsBySession[sid] ?? [];
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sid]: list.filter((q) => q.questionId !== questionId),
    };
  } catch (err) {
    pushOperationFailure('respondQuestion', err, { sessionId: sid });
  }
}

async function dismissQuestion(questionId: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    const api = getKimiWebApi();
    await api.dismissQuestion(sid, questionId);
    const list = rawState.questionsBySession[sid] ?? [];
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sid]: list.filter((q) => q.questionId !== questionId),
    };
  } catch (err) {
    pushOperationFailure('dismissQuestion', err, { sessionId: sid });
  }
}

async function cancelTask(taskId: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    const api = getKimiWebApi();
    await api.cancelTask(sid, taskId);
    // Update task status locally
    const list = rawState.tasksBySession[sid] ?? [];
    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      [sid]: list.map((t) =>
        t.id === taskId ? { ...t, status: 'cancelled' as const } : t,
      ),
    };
  } catch (err) {
    pushOperationFailure('cancelTask', err, { sessionId: sid });
  }
}

/** Persist and apply a new extended-thinking level (also pushed to the active
 *  session profile so the daemon's /status reflects it; still sent per-prompt). */
function setThinking(level: ThinkingLevel): void {
  const next = applyThinkingLevel(level);
  persistSessionProfile({ thinking: next });
}

/** Persist and apply plan mode (pushed to the session profile + sent per-prompt). */
function setPlanMode(on: boolean): void {
  rawState.planMode = on;
  savePlanModeToStorage(on);
  persistSessionProfile({ planMode: on });
}

/** Flip plan mode on/off. */
function togglePlanMode(): void {
  setPlanMode(!rawState.planMode);
}

/** Persist and apply swarm mode (pushed to the session profile + sent per-prompt). */
function setSwarmMode(on: boolean): void {
  rawState.swarmMode = on;
  saveSwarmModeToStorage(on);
  persistSessionProfile({ swarmMode: on });
}

/** Flip swarm mode on/off. In manual permission mode, ask before enabling. */
function toggleSwarmMode(): void {
  const on = !rawState.swarmMode;
  if (on && rawState.permission === 'manual') {
    const ok = confirm('Enable swarm mode? The agent will run multiple sub agents in parallel.');
    if (!ok) return;
  }
  setSwarmMode(on);
}

/** Persist goal mode locally. Unlike plan/swarm, this is a one-shot flag consumed on send. */
function setGoalMode(on: boolean): void {
  rawState.goalMode = on;
  saveGoalModeToStorage(on);
}

/** Flip goal mode on/off. */
function toggleGoalMode(): void {
  setGoalMode(!rawState.goalMode);
}

/** Create a goal by sending its objective to the session profile, then submit it as a prompt. */
async function createGoal(objective: string): Promise<void> {
  const trimmed = objective.trim();
  if (!trimmed) return;
  if (rawState.permission === 'manual') {
    const ok = confirm(`Start goal: "${trimmed}"? The agent will run autonomously toward this objective.`);
    if (!ok) return;
  }
  const sid = rawState.activeSessionId;
  if (!sid) return;
  try {
    await getKimiWebApi().updateSession(sid, { goalObjective: trimmed });
  } catch (err) {
    pushOperationFailure('createGoal', err, { sessionId: sid, message: goalErrorMessage(err) });
    return;
  }
  await sendPrompt(trimmed);
}

/** Send a one-shot goal control action (pause/resume/cancel). */
function controlGoal(action: 'pause' | 'resume' | 'cancel'): void {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  void Promise.resolve(getKimiWebApi().updateSession(sid, { goalControl: action }))
    .catch((err) => {
      pushOperationFailure('controlGoal', err, { sessionId: sid, message: goalErrorMessage(err) });
    });
}

/** Persist and apply a new permission mode; auto-approve pending approvals if switching to auto/yolo */
function setPermission(mode: PermissionMode): void {
  rawState.permission = mode;
  savePermissionToStorage(mode);
  persistSessionProfile({ permissionMode: mode });

  // If switching to auto/yolo, auto-approve any currently-pending approvals for the active session
  if (mode === 'auto' || mode === 'yolo') {
    const sid = rawState.activeSessionId;
    if (sid) {
      const approvals = [...(rawState.approvalsBySession[sid] ?? [])];
      for (const a of approvals) {
        void respondApproval(a.approvalId, {
          decision: 'approved',
          scope: mode === 'yolo' ? 'session' : undefined,
        });
      }
    }
  }
}

/** Dismiss a warning by index */
function dismissWarning(index: number): void {
  const list = [...rawState.warnings];
  list.splice(index, 1);
  rawState.warnings = list;
}

/** Rename a session — calls API and updates local state */
async function renameSession(id: string, title: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.updateSession(id, { title });
    rawState.sessions = rawState.sessions.map((s) =>
      s.id === id ? { ...s, title } : s,
    );
  } catch (err) {
    pushOperationFailure('renameSession', err, { sessionId: id });
  }
}

/** Rename a workspace — local-only until the daemon ships a workspace update API. */
function renameWorkspace(id: string, name: string): void {
  rawState.workspaces = rawState.workspaces.map((w) =>
    w.id === id ? { ...w, name } : w,
  );
}

/** Delete a workspace — calls API, removes locally */
async function deleteWorkspace(id: string): Promise<void> {
  // "Remove workspace" only hides the sidebar entry — it never deletes sessions
  // or history. The daemon DELETE is registry-only and mergedWorkspaces would
  // otherwise re-derive the workspace from any session cwd still pointing at it,
  // so it would pop right back. To make remove actually stick (even when the
  // workspace has sessions), record its ROOT in the persisted hidden set; the
  // merge then skips it. Re-adding the same path un-hides it (see addWorkspace).
  const root =
    rawState.workspaces.find((w) => w.id === id)?.root ??
    mergedWorkspaces.value.find((w) => w.id === id)?.root ??
    id; // derived workspaces use the cwd as their id
  const activeSession = rawState.activeSessionId
    ? rawState.sessions.find((s) => s.id === rawState.activeSessionId)
    : undefined;
  const removingActiveWorkspace = rawState.activeWorkspaceId === id || rawState.activeWorkspaceId === root;
  const activeSessionInRemovedWorkspace = Boolean(
    activeSession &&
      (activeSession.cwd === root ||
        activeSession.workspaceId === id ||
        workspaceIdForSession(activeSession) === id),
  );
  if (root && !rawState.hiddenWorkspaceRoots.includes(root)) {
    rawState.hiddenWorkspaceRoots = [...rawState.hiddenWorkspaceRoots, root];
    saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
  }
  // Best-effort registry cleanup; ignore failures (the hide already took effect).
  try {
    await getKimiWebApi().deleteWorkspace(id);
  } catch {
    // registry delete is optional — the sidebar hide is what the user sees.
  }
  rawState.workspaces = rawState.workspaces.filter((w) => w.id !== id && w.root !== root);
  if (removingActiveWorkspace || activeSessionInRemovedWorkspace) {
    const nextWorkspace = mergedWorkspaces.value[0]?.id ?? null;
    rawState.activeWorkspaceId = nextWorkspace;
    if (nextWorkspace) saveActiveWorkspaceToStorage(nextWorkspace);
    else {
      try { safeRemove(ACTIVE_WORKSPACE_KEY); } catch { /* ignore */ }
    }
  }
  if (removingActiveWorkspace || activeSessionInRemovedWorkspace) {
    rawState.activeSessionId = undefined;
    rawState.sessionLoading = false;
    clearFileDiff();
    writeSessionUrl(undefined, 'replace');
  }
}

/** Archive a session — calls API, persists the archive flag, removes locally, picks another active session or none */
async function archiveSession(id: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.archiveSession(id);
    rawState.sessions = rawState.sessions.filter((s) => s.id !== id);
    clearSideChatForSession(id);
    const { [id]: _removedIds, ...restIds } = rawState.sideChatUserMessageIdsBySession;
    void _removedIds;
    rawState.sideChatUserMessageIdsBySession = restIds;

    // If archived session was active, pick another. 'replace' so the address
    // bar doesn't keep pointing at (and back doesn't return to) a dead session.
    if (rawState.activeSessionId === id) {
      const next = rawState.sessions[0];
      if (next) {
        await selectSession(next.id, { urlMode: 'replace' });
      } else {
        rawState.activeSessionId = undefined;
        writeSessionUrl(undefined, 'replace');
      }
    }
  } catch (err) {
    pushOperationFailure('archiveSession', err, { sessionId: id });
  }
}

// ---------------------------------------------------------------------------
// Model + Provider actions
// ---------------------------------------------------------------------------

/** Load models (cached — call again to force refresh) */
async function loadModels(): Promise<void> {
  try {
    const api = getKimiWebApi();
    models.value = await api.listModels();
    applyThinkingLevel(rawState.thinking);
  } catch (err) {
    pushOperationFailure('loadModels', err);
  }
}

async function refreshOAuthProviderModels(): Promise<void> {
  try {
    const result = await getKimiWebApi().refreshOAuthProviderModels();
    for (const failure of result.failed) {
      pushOperationFailure('refreshOAuthProviderModels', new Error(failure.reason), {
        message: failure.provider,
      });
    }
  } catch {
    // Older daemons may not expose this endpoint; model listing still works.
  }
}

/** Load providers */
async function loadProviders(): Promise<void> {
  try {
    const api = getKimiWebApi();
    providers.value = await api.listProviders();
  } catch (err) {
    pushOperationFailure('loadProviders', err);
  }
}

/**
 * Switch model for the active session via POST /sessions/{id}/profile (the
 * daemon dispatches agent_config.model to core.rpc.setModel). The profile echo
 * can return model '', so the authoritative current model comes from
 * GET /sessions/{id}/status, which we re-read right after. Optimistically show
 * the chosen id meanwhile. Never crashes.
 */
async function setModel(modelId: string): Promise<void> {
  const sid = rawState.activeSessionId;
  const nextThinking = coerceThinkingForModel(modelById(modelId), rawState.thinking);
  const prevThinking = rawState.thinking;
  if (!sid) {
    // New-session draft (onboarding composer): no backend session to update.
    // Remember the pick — startSessionAndSendPrompt applies it at create time.
    draftModel.value = modelId;
    applyThinkingLevel(nextThinking);
    return;
  }
  // Optimistic: show the chosen model immediately, but remember the previous
  // one so we can roll back if the switch never reaches the daemon.
  const prevModel = rawState.sessions.find((s) => s.id === sid)?.model;
  rawState.sessions = rawState.sessions.map((s) => (s.id === sid ? { ...s, model: modelId } : s));
  if (nextThinking !== prevThinking) {
    rawState.thinking = nextThinking;
    saveThinkingToStorage(nextThinking);
  }
  try {
    await getKimiWebApi().updateSession(sid, {
      model: modelId,
      thinking: nextThinking !== prevThinking ? nextThinking : undefined,
    });
  } catch (err) {
    // The model change rides HTTP, not the WS, so a dropped socket alone does
    // not fail it — but when the daemon is unreachable the request throws here.
    // Roll the picker back to the real model so the UI can't keep showing the
    // new one as if the switch succeeded, then surface the failure.
    rawState.sessions = rawState.sessions.map((s) =>
      s.id === sid ? { ...s, model: prevModel ?? s.model } : s,
    );
    if (nextThinking !== prevThinking) {
      rawState.thinking = prevThinking;
      saveThinkingToStorage(prevThinking);
    }
    pushOperationFailure('setModel', err, { sessionId: sid });
    return;
  }
  // refreshSessionStatus folds the authoritative current model from /status
  // back into the session (the profile echo can return ''). Best-effort: a
  // failure here does not mean the switch failed, so it must not roll back.
  await refreshSessionStatus(sid);
}

/** Toggle whether a model is starred (favorited) in the model picker. */
function toggleStarModel(modelId: string): void {
  const set = new Set(starredModelIds.value);
  if (set.has(modelId)) {
    set.delete(modelId);
  } else {
    set.add(modelId);
  }
  starredModelIds.value = Array.from(set);
  saveStarredModelsToStorage(starredModelIds.value);
}

/**
 * Activate a session skill (the web analogue of typing `/<skill> <args>` in the
 * TUI). The daemon starts a turn with a `skill_activation` origin; progress
 * arrives over the WS stream like any other turn. Never crashes the caller.
 */
async function activateSkill(skillName: string, args?: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  const guarded = activity.value === 'idle' && !inFlightPromptSessions.has(sid);
  const tempId = `msg_skill_opt_${Date.now().toString(36)}`;

  if (guarded) {
    inFlightPromptSessions.add(sid);
    rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: true };
    const optimisticMsg: AppMessage = {
      id: tempId,
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: `/${skillName}${args ? ` ${args}` : ''}` }],
      createdAt: new Date().toISOString(),
      metadata: {
        'kimiWeb.optimisticUserMessage': true,
        origin: {
          kind: 'skill_activation',
          trigger: 'user-slash',
          skillName,
          skillArgs: args,
        },
      },
    };
    rawState.messagesBySession = {
      ...rawState.messagesBySession,
      [sid]: [...(rawState.messagesBySession[sid] ?? []), optimisticMsg],
    };
  }

  try {
    await getKimiWebApi().activateSkill(sid, skillName, args);
  } catch (err) {
    if (guarded) {
      inFlightPromptSessions.delete(sid);
      rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
      const msgs = rawState.messagesBySession[sid] ?? [];
      rawState.messagesBySession = {
        ...rawState.messagesBySession,
        [sid]: msgs.filter((m) => m.id !== tempId),
      };
    }
    pushOperationFailure('activateSkill', err, { sessionId: sid });
  }
}

/** Add a provider, then reload providers + models */
async function addProvider(input: {
  type: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.addProvider(input);
    await Promise.all([loadProviders(), loadModels()]);
  } catch (err) {
    pushOperationFailure('addProvider', err);
  }
}

/** Delete a provider, then reload providers + models */
async function deleteProvider(id: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.deleteProvider(id);
    await Promise.all([loadProviders(), loadModels()]);
  } catch (err) {
    pushOperationFailure('deleteProvider', err);
  }
}

/** Refresh a provider status */
async function refreshProvider(id: string): Promise<void> {
  try {
    const api = getKimiWebApi();
    const updated = await api.refreshProvider(id);
    providers.value = providers.value.map((p) => (p.id === id ? updated : p));
  } catch (err) {
    pushOperationFailure('refreshProvider', err);
  }
}

/** Start managed Kimi OAuth device flow. Returns flow data or null on error. */
async function startOAuthLogin(): Promise<{
  flowId: string;
  provider: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  status: 'pending';
  expiresAt: string;
} | null> {
  try {
    const api = getKimiWebApi();
    return await api.startOAuthLogin();
  } catch {
    return null;
  }
}

/** Poll the singleton OAuth flow. Returns null on error or no active flow. */
async function pollOAuthLogin(): Promise<{
  flowId: string;
  status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
  resolvedAt?: string;
} | null> {
  try {
    const api = getKimiWebApi();
    return await api.pollOAuthLogin();
  } catch {
    return null;
  }
}

/** Cancel the current OAuth flow (best-effort). */
async function cancelOAuthLogin(): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.cancelOAuthLogin();
  } catch {
    // Best-effort
  }
}

/** Logout from the managed Kimi provider. Re-checks auth and reloads sessions. */
async function logout(): Promise<void> {
  try {
    const api = getKimiWebApi();
    await api.logout();
    await checkAuth();
    await load();
  } catch (err) {
    pushOperationFailure('logout', err);
  }
}

/**
 * compact() — request history compaction via POST /sessions/{id}:compact.
 * Progress arrives asynchronously through the WS compaction.* events (running
 * notice → divider marker), so we just fire the request. An optional
 * instruction (from `/compact <text>`) steers what the summary focuses on.
 */
function compact(instruction?: string): void {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  void getKimiWebApi()
    .compactSession(sid, instruction)
    .catch((err) => {
      pushOperationFailure('compact', err, { sessionId: sid });
    });
}

/**
 * forkSession() — fork the active session into a new child session via
 * POST /sessions/{id}:fork, then add it to the list and select it.
 */
async function forkSession(sessionId?: string): Promise<void> {
  const sid = sessionId ?? rawState.activeSessionId;
  if (!sid) return;
  try {
    const forked = await getKimiWebApi().forkSession(sid);
    rawState.sessions = [forked, ...rawState.sessions.filter((s) => s.id !== forked.id)];
    await selectSession(forked.id);
  } catch (err) {
    pushOperationFailure('fork', err, { sessionId: sid });
  }
}

/**
 * Undo the last `count` turns of the active session (daemon :undo), then re-sync
 * the snapshot so the local transcript matches the daemon's post-undo history.
 * Returns the text of the most-recent user message that was undone, so the UI
 * can offer "edit + resend" (load it back into the composer).
 */
async function undo(count = 1): Promise<string | null> {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  // Capture the last user message text BEFORE the undo removes it.
  const lastUserText = (() => {
    const msgs = rawState.messagesBySession[sid] ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role !== 'user') continue;
      if (m.metadata?.['origin'] && (m.metadata['origin'] as { kind?: string }).kind !== 'user') continue;
      return m.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }
    return null;
  })();
  try {
    await getKimiWebApi().undoSession(sid, count);
    await syncSessionFromSnapshot(sid);
    return lastUserText;
  } catch (err) {
    pushOperationFailure('undo', err, { sessionId: sid });
    return null;
  }
}

/**
 * Remove a queued message for the active session by index.
 * Defensive: no-op if index out of range or no active session.
 */
function unqueue(index: number): void {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  const current = rawState.queuedBySession[sid] ?? [];
  if (index < 0 || index >= current.length) return;
  const next = [...current];
  next.splice(index, 1);
  rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: next };
}

/**
 * List directory contents for the active session.
 * Returns FsEntry[] — defensive, returns [] on error or no active session.
 */
async function listDir(path: string): Promise<FsEntry[]> {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  try {
    const api = getKimiWebApi();
    const result = await api.listDirectory(sid, { path, includeGitStatus: true });
    return result.items;
  } catch {
    return [];
  }
}

/**
 * Read file content for the active session.
 * Returns the file metadata + content (including path), or null on error or no active session.
 */
async function readFileContent(path: string): Promise<{
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime: string;
  languageId?: string;
  isBinary: boolean;
  size: number;
  lineCount?: number;
} | null> {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  try {
    const api = getKimiWebApi();
    const result = await api.readFile(sid, { path });
    return {
      path: result.path,
      content: result.content,
      encoding: result.encoding,
      mime: result.mime,
      languageId: result.languageId,
      isBinary: result.isBinary,
      size: result.size,
      lineCount: result.lineCount,
    };
  } catch {
    return null;
  }
}

// Matches the daemon's FS_READ_MAX_BYTES. Without an explicit length the
// protocol defaults to 1MiB and silently truncates — half a PNG decodes as a
// broken image, which is worse than falling back to the original src.
const IMAGE_READ_MAX_BYTES = 10_485_760;

function getFileDownloadUrl(path: string): string | null {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return getKimiWebApi().getFileDownloadUrl(sid, path);
}

async function openWorkspaceFile(path: string, line?: number): Promise<boolean> {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  try {
    await getKimiWebApi().openFile(sid, { path, line });
    return true;
  } catch (err) {
    pushOperationFailure('openFile', err, { sessionId: sid });
    return false;
  }
}

/** Open the current workspace in an external application (Finder, Cursor, etc.). */
async function openInApp(appId: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) return;
  const path = status.value.cwd || '.';
  try {
    await getKimiWebApi().openInApp(sid, appId, path);
  } catch (err) {
    pushOperationFailure('openInApp', err, { sessionId: sid });
  }
}

async function revealWorkspaceFile(path: string): Promise<boolean> {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  try {
    await getKimiWebApi().revealFile(sid, { path });
    return true;
  } catch (err) {
    pushOperationFailure('revealFile', err, { sessionId: sid });
    return false;
  }
}

/**
 * Resolve a local image path to a displayable data URL.
 * Non-local URLs (http/https/data) pass through unchanged.
 * Local paths are read via the daemon's readFile endpoint and returned as
 * data:{mime};base64,{content} URLs so they render in the browser. Absolute
 * paths are made cwd-relative first (the daemon rejects absolute paths), and
 * truncated/non-binary reads fall back to the original src.
 */
async function resolveImageUrl(src: string): Promise<string> {
  // Pass through already-addressable URLs
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  const sid = rawState.activeSessionId;
  if (!sid) return src;

  // The daemon's path resolution only accepts session-relative paths, but the
  // model usually references images by absolute path. Strip the session cwd.
  let path = src;
  if (path.startsWith('/')) {
    const cwd = rawState.sessions.find((s) => s.id === sid)?.cwd;
    if (cwd && (path === cwd || path.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`))) {
      path = path.slice(cwd.length).replace(/^\//, '');
      if (!path) return src;
    } else {
      return src; // absolute path outside the workspace — unreadable
    }
  }

  try {
    const api = getKimiWebApi();
    const result = await api.readFile(sid, { path, length: IMAGE_READ_MAX_BYTES });
    if (!result.isBinary || result.encoding !== 'base64' || result.truncated) return src;
    return `data:${result.mime};base64,${result.content}`;
  } catch {
    return src;
  }
}

/**
 * Search files in the active session using the daemon searchFiles endpoint.
 * Returns {path, name}[] — defensive, returns [] on error or no active session.
 */
async function searchFiles(query: string): Promise<Array<{ path: string; name: string }>> {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  try {
    const api = getKimiWebApi();
    const result = await api.searchFiles(sid, { query, limit: 20 });
    return result.items.map((item) => ({ path: item.path, name: item.name }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Composable return
// ---------------------------------------------------------------------------

export function useKimiWebClient() {
  ensureSessionTimeClock();

  return {
    // Reactive state / computed view props
    workspace,
    sessions,
    activeSessionId,

    // Workspace view props
    workspacesView,
    visibleWorkspace,
    activeWorkspaceId,
    sessionsForView,
    workspaceGroups,
    attentionBySession,
    pendingBySession,
    attentionByWorkspace,
    unreadBySession,
    recentRoots,

    turns,
    tasks,
    todos,
    goal,
    swarms,
    activationBadges,
    compaction,
    status,
    sessionCost,
    fileDiff,
    selectedDiffPath,
    fileDiffLoading,
    changes,
    gitInfo,
    gitDiffStats,
    activePullRequest,
    changesByPath,
    pendingApprovals,
    recentCwds,
    availableOpenInApps,

    // New Phase 1 computed
    connection,
    loading,
    sessionLoading,
    loadingMoreMessages,
    hasMoreMessages,
    loadMoreMessagesError,
    serverVersion,
    initialized,
    permission,
    thinking,
    planMode,
    swarmMode,
    goalMode,
    queued,
    warnings,
    questions,
    activity,
    isSending,
    fastMoon: appearance.fastMoon,

    // Model + Provider reactive state
    models,
    starredModelIds,
    providers,

    // Theme
    theme: appearance.theme,
    setTheme: appearance.setTheme,
    toggleTheme: appearance.toggleTheme,
    uiFontSize: appearance.uiFontSize,
    setUiFontSize: appearance.setUiFontSize,

    // Beta features
    betaToc,
    setBetaToc,

    // Color scheme
    colorScheme: appearance.colorScheme,
    setColorScheme: appearance.setColorScheme,

    accent: appearance.accent,
    setAccent: appearance.setAccent,
    notifyOnComplete: notification.notifyOnComplete,
    notifyPermission: notification.notifyPermission,
    setNotifyOnComplete: notification.setNotifyOnComplete,
    onboarded,
    setOnboarded,

    // Actions
    load,
    selectSession,
    createSession,
    loadOlderMessages,

    // Workspace actions
    loadWorkspaces,
    selectWorkspace,
    openWorkspace,
    openWorkspaceDraft,
    createSessionInWorkspace,
    startSessionAndSendPrompt,
    addWorkspaceByPath,
    browseFs,
    getFsHome,

    sendPrompt,
    steerPrompt,
    // Side chat (BTW side-channel agent)
    sideChatVisible,
    sideChatSessionId,
    sideChatTurns,
    sideChatRunning,
    sideChatSending,
    openSideChat,
    closeSideChat,
    sendSideChatPrompt,
    uploadImage,
    abortCurrentPrompt,
    respondApproval,
    respondQuestion,
    dismissQuestion,
    cancelTask,

    // New Phase 1 actions
    setPermission,
    setThinking,
    setPlanMode,
    togglePlanMode,
    setSwarmMode,
    toggleSwarmMode,
    setGoalMode,
    toggleGoalMode,
    createGoal,
    controlGoal,
    enqueue,
    dismissWarning,
    renameSession,
    renameWorkspace,
    deleteWorkspace,
    archiveSession,
    compact,
    forkSession,
    undo,

    // New Phase 4 actions
    unqueue,
    searchFiles,
    loadGitStatus,
    loadFileDiff,
    clearFileDiff,

    // File system actions
    listDir,
    readFileContent,
    getFileDownloadUrl,
    openWorkspaceFile,
    openInApp,
    revealWorkspaceFile,
    resolveImageUrl,

    // Model + Provider actions
    refreshOAuthProviderModels,
    loadModels,
    loadProviders,
    skills,
    activateSkill,
    setModel,
    toggleStarModel,
    addProvider,
    deleteProvider,
    refreshProvider,

    // Auth state
    authReady,
    defaultModel,
    managedProviderStatus,

    // Config state + actions
    config,
    updateConfig,

    // Auth actions
    checkAuth,
    startOAuthLogin,
    pollOAuthLogin,
    cancelOAuthLogin,
    logout,
  };
}

// Re-export types used by wired components so they can import from one place
export type { ApprovalDecision, AppModel, AppProvider };
