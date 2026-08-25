// packages/app-client/src/client/types.ts
// The facade's reactive state shape (ExtendedState) and the prompt-attachment
// wire type, extracted from the apps' useKimiWebClient god object so the
// client-layer modules (useTaskPoller / useSideChat / useModelProviderState)
// can live in this package without importing app-side modules. The apps
// re-export these from their useKimiWebClient for existing consumers.

import type {
  AppConfig,
  AppMessage,
  AppSession,
  AppWorkspace,
  KimiClientState,
  ManagedUserInfo,
  ThinkingLevel,
} from '@moonshot-ai/app-core/api';
import type { ConnectionState, PermissionMode } from '@moonshot-ai/app-core/client/types';

export interface GitStatusEntry {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
  additions: number;
  deletions: number;
  pullRequest: { number: number; state: string; url: string } | null;
}

/** An uploaded attachment to send with a prompt. `kind` drives the content-block
    type: images/videos become media parts; any other kind becomes a file part
    the server materializes and hands to the model as a path reference.
    name/mediaType/size feed the wire file shape (the server's file-store meta
    stays authoritative, so a chip reloaded from history may omit them). */
export type PromptAttachment = {
  fileId: string;
  kind: 'image' | 'video' | 'file';
  /** Set for media restored from a session transcript. The file id then
      belongs to that session's canonical media store, not the upload store. */
  sessionId?: string;
  name?: string;
  mediaType?: string;
  size?: number;
};

/** A prompt waiting for the session to go idle. Keeps the uploaded
    fileIds so attachments survive queueing (not just the text). The id keys
    the per-entry flush failure budget locally (assigned at enqueue). */
interface QueuedPrompt {
  text: string;
  attachments?: PromptAttachment[];
  id?: string;
  /** The pre-rewrite draft for edit-reload (selection quote pills revive
      from their link form) — the queued `text` stays the daemon-bound wire
      form and is never touched by editing. */
  editText?: string;
}

/** Membership of the signed-in managed account: 'member' or 'free' once
    known, null while unknown. */
export type ManagedMembership = 'member' | 'free' | null;

export interface ExtendedState extends KimiClientState {
  connected: boolean;
  serverVersion: string;
  /** Seq of the latest lastTurnReason-changing event per session
   *  (sessionWorkChanged / turnActiveChanged): undo/resync session reads
   *  compare against it so an older REST answer can't resurrect a newer
   *  outcome — including ABA flips a value comparison can't see. */
  sessionLastTurnReasonSeqBySession: Record<string, number>;
  /** The prompt id an :abort should target (the RUNNING prompt, queue as
   *  fallback) — separate from promptIdBySession, which stays the identity of
   *  OUR last submission for terminal/optimistic reconciliation. The
   *  transcript backfill only ever writes THIS field, so another client's
   *  live prompt can't overwrite our identity. */
  abortPromptIdBySession: Record<string, string>;
  /**
   * True when the connected server reports `dangerous_bypass_auth` in `/meta`,
   * meaning its bearer-token gate is disabled. The UI skips the server-token
   * prompt and connects without a credential.
   */
  dangerousBypassAuth: boolean;
  /**
   * Engine generation of the connected server: `'v2'` = kap-server /
   * agent-core-v2, `'v1'` = an older (legacy) server binary. Read from `/meta`
   * (`backend` field; older servers omit it ⇒ v1). Drives the dev-mode
   * backend badge in the Sidebar.
   */
  backend: 'v1' | 'v2';
  /** Effective experimental-flag state (flag id → enabled) reported by the
   * server via GET /meta; `{}` until the first meta fetch and on servers too
   * old to report it. Drives flag-gated UI (e.g. the secondary-model settings
   * section). */
  experimentalFlags: Record<string, boolean>;
  /** Custom browser tab title for this instance, reported by the server via
   * GET /meta (`web_title`; the CLI's `--web-title`). `''` until the first
   * meta fetch and when the server was started without the flag — the tab
   * title then falls back to `<workspace dir> | Kimi Code`. */
  webTitle: string;
  workspaceName: string;
  connection: ConnectionState;
  permission: PermissionMode;
  /** The thinking level shown and submitted for the ACTIVE session. Resolved by
   *  useModelProviderState: the session's own daemon-reported level
   *  (`thinkingBySession`) when the model still declares it, else the model's
   *  stored per-model pick, else its catalog default — undefined only
   *  transiently before that, so display and submission always agree. */
  thinking: ThinkingLevel | undefined;
  /** The session's own thinking level as reported by the daemon (GET
   *  /sessions/{id}/status `thinking_level` and WS `agent.status.updated`),
   *  keyed by session id. Per-session state wins over the per-model
   *  localStorage pick: a session keeps the level it actually ran with, so
   *  switching sessions never leaks one session's pick into another. */
  thinkingBySession: Record<string, ThinkingLevel>;
  /** Write token of the latest thinking pick the daemon has not acknowledged
   *  yet — while present, daemon reports are dropped (markThinkingPending /
   *  foldDaemonThinkingLevel). */
  pendingThinkingBySession: Record<string, number>;
  /** Plan mode per session — the DAEMON FACT ONLY: written by /status folds
   *  and the status.updated projection (the model may also enter plan on its
   *  own via EnterPlanMode). The user's not-yet-sent toggle never lands here;
   *  that intent lives in planArmedBySession. */
  planModeBySession: Record<string, boolean>;
  /** Plan-mode ARMED flag per session: the user's intent — "the next send
   *  cashes this into the profile write that activates plan on the daemon".
   *  Persisted to storage (an unsent intent survives a reload). */
  planArmedBySession: Record<string, boolean>;
  /** Write token of the latest plan-mode profile write the daemon has not
   *  acknowledged yet — while present, daemon reports are dropped
   *  (markPlanPending / foldDaemonPlanMode), same shield shape as
   *  pendingSwarmBySession. */
  pendingPlanBySession: Record<string, number>;
  /** Swarm-mode toggle per session. */
  swarmModeBySession: Record<string, boolean>;
  /** Write token of the latest swarm-mode pick the daemon has not acknowledged
   *  yet — while present, daemon reports are dropped (markSwarmPending /
   *  foldDaemonSwarmMode), same shield shape as pendingThinkingBySession. */
  pendingSwarmBySession: Record<string, number>;
  /** Goal-mode (one-shot "next send creates a goal") toggle per session. */
  goalModeBySession: Record<string, boolean>;
  loading: boolean;
  sessionLoading: boolean;
  queuedBySession: Record<string, QueuedPrompt[]>;
  gitStatusBySession: Record<string, GitStatusEntry>;
  // Real daemon prompt_id of the last submitted prompt, per session. This is the
  // AUTHORITATIVE id for :abort — the event projector synthesizes a `pr_…` id
  // when turn.started races ahead of binding, which the daemon rejects.
  promptIdBySession: Record<string, string>;
  // A prompt this client submitted (or skill-activated) has not reached its
  // terminal state yet — the OPTIMISTIC half of the working indicator, covering the
  // window before the turn.started round-trips (and the queue-drain re-arm).
  // Set at every local turn entry point; cleared by finishPromptLocal, the
  // entry points' own error paths, the authoritative-quiet fallback, or session
  // forget. `turnActiveBySession` owns everything from turn.started on.
  inFlightBySession: Record<string, boolean>;
  // The composer's optimistic user bubbles, kept OUT of any transcript or
  // message pipeline (S8): pure UI state rendered until the transcript's turn
  // header covers the same prompt text, then dropped by the overlay.
  optimisticMessagesBySession: Record<string, AppMessage[]>;
  // True when a BACKGROUND session finished a turn the user hasn't opened since
  // (drives the unread blue dot in the sidebar). Set on idle for a non-active
  // session, cleared when the session is selected.
  unreadBySession: Record<string, boolean>;
  // Auth state (real daemon)
  authReady: boolean;
  defaultModel: string | null;
  managedProviderStatus: string | null;
  /** Signed-in managed-account profile (GET /oauth/userinfo); null until
      fetched, on fetch failure, and when signed out. */
  managedUserInfo: ManagedUserInfo | null;
  /** Membership derived from the userinfo probe (see ManagedMembership) —
      drives the upgrade entries in the composer / settings / user menu. */
  managedMembership: ManagedMembership;
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
  sideChatUserMessageIdsBySession: Record<string, string[]>;
  /** Local sending flag for BTW agents; agent ids are not session ids. */
  sideChatSendingByAgent: Record<string, boolean>;
  /** Whether the server has more sessions than currently loaded, per workspace. */
  sessionsHasMoreByWorkspace: Record<string, boolean>;
  /** True while the next page of sessions is being fetched for a workspace. */
  sessionsLoadingMoreByWorkspace: Record<string, boolean>;
  /** Paging cursor (`before_id`) for the next session page, per workspace. Tracks
   *  the end of the last fetched page so a deep-linked older session appended
   *  out of band does not shift the cursor and skip intervening sessions. */
  sessionsCursorByWorkspace: Record<string, string | undefined>;
  /** First-page capacity per workspace (sessions loaded on first paint, floored
   *  at one full page). Drives the sidebar's in-group show-less collapse target. */
  sessionsInitialCountByWorkspace: Record<string, number>;
  /** True once every session has been loaded (after a search-triggered full drain). */
  sessionsFullyLoaded: boolean;
  /** Opaque cursor for the next flat-list page (GET /api/v2/sessions); null when
   *  no next page is known (pre-seed or fully drained). */
  flatSessionsNextPageToken: string | null;
  /** Whether the v2 endpoint reports more flat-list pages. */
  flatSessionsHasMore: boolean;
  /** True while the first flat-list page is being fetched. */
  flatSessionsLoading: boolean;
  /** True while a follow-up flat-list page is being fetched. */
  flatSessionsLoadingMore: boolean;
  /** True once the flat list has fetched its first page this run (seeding is one-shot). */
  flatSessionsSeeded: boolean;
  /** The oldest updated_at (ms) the contiguous v2 walk has reached. The flat
   *  view renders only pool rows at/inside this frontier (attention rows
   *  excepted): rows pooled from other sources carry no global-order
   *  guarantee until the walk covers them. null = not seeded yet. */
  flatSessionsFrontier: number | null;
  /** Done (archived) sessions for the sidebar status view's 已完成 tab, fed by
   *  GET /api/v2/sessions with archived:true. Kept OUT of the shared pool on
   *  purpose: the local archive path forgets pool rows (forgetSession), so a
   *  pool projection could not retain just-archived sessions. Live WS updates
   *  do not reach this array (renames elsewhere won't live-update); it
   *  re-seeds on entry to the tab. */
  doneSessions: AppSession[];
  /** Opaque cursor for the next done-list page; null when no next page is
   *  known (pre-seed or fully drained). */
  doneSessionsNextPageToken: string | null;
  /** Whether the v2 endpoint reports more done-list pages. */
  doneSessionsHasMore: boolean;
  /** True while the first done-list page is being fetched. */
  doneSessionsLoading: boolean;
  /** True while a follow-up done-list page is being fetched. */
  doneSessionsLoadingMore: boolean;
  /** True once the done list has fetched its first page this run. */
  doneSessionsSeeded: boolean;
  /** How the current draft (empty-session state) was entered: 'newChat' = the
   *  primary 新建会话 button (shows the brand doodle hero); 'workspace' = a
   *  workspace directory row / add-workspace flow (shows the workspace home
   *  with recent sessions, no doodle). Only meaningful while no session is
   *  active. */
  draftEntry: 'newChat' | 'workspace';
  /** Main content view: 'chat' = the conversation pane; 'sessionAdmin' = the
   *  session admin page, a full-pane view switched with v-show so the chat
   *  (and its active session) stays alive underneath. URL-bound:
   *  'sessionAdmin' ↔ /admin/sessions — while it is the main view it owns the
   *  address bar and session-URL writes are suspended (see writeSessionUrl).
   *  Desktop-only for now; web initializes the field but never leaves 'chat'. */
  mainView: 'chat' | 'sessionAdmin';
}
