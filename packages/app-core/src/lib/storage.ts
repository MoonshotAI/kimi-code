// packages/app-core/src/lib/storage.ts
// Thin, safe wrapper over localStorage: raw read/write/remove plus JSON
// helpers, each guarded with try/catch. No validation, clamping, or enum
// checks here — those stay at call sites. Read helpers return null when the
// key is missing or storage is unavailable, so callers decide their own
// fallback. Centralizes the persisted key strings so each key has a single
// source of truth.

import type { WorkspaceSortMode } from './workspaceOrder';

export const STORAGE_KEYS = {
  // useKimiWebClient
  permission: 'kimi-web.permission',
  activeWorkspace: 'kimi-active-workspace',
  // The ARMED plan intent (unsent toggle, cashed on the next send) — versioned
  // away from planMode, whose pre-intent values mirrored the daemon FACT and
  // must never be loaded as an intent (a stale true would cash planMode:true
  // into the next plain message).
  planArmed: 'kimi-web.plan-armed',
  swarmMode: 'kimi-web.swarm-mode',
  goalMode: 'kimi-web.goal-mode',
  fontScale: 'kimi-web.font-scale',
  starredModels: 'kimi-web.starred-models',
  unread: 'kimi-web.unread',
  onboarded: 'kimi-web.onboarded',
  colorScheme: 'kimi-web.color-scheme',
  hiddenWorkspaces: 'kimi-web.hidden-workspaces',
  collapsedWorkspaces: 'kimi-web.collapsed-workspaces',
  workspaceOrder: 'kimi-web.workspace-order',
  workspaceSort: 'kimi-web.workspace-sort',
  workspaceRecencyFloor: 'kimi-web.workspace-recency-floor',
  pinnedSessions: 'kimi-web.pinned-sessions',
  pinnedCollapsed: 'kimi-web.pinned-collapsed',
  workspaceNameOverrides: 'kimi-web.workspace-name-overrides',
  notifyEnabled: 'kimi-web.notify-enabled',
  notifySound: 'kimi-web.notify-sound',
  inputHistory: 'kimi-web.input-history',
  // cross-file
  locale: 'kimi-locale',
  clientId: 'kimi-web.client-id',
  debug: 'kimi-web.debug',
  openInDefaultTarget: 'kimi-web.open-in.default-target',
  // Web's OpenInMenu still uses the pre-rename key. Both entries stay (the
  // persisted key strings are a protocol — never rename or clean up).
  openInLastTarget: 'kimi-web.open-in.last-target',
  sidebarCollapsed: 'kimi-web.sidebar-collapsed',
  sidebarWidth: 'kimi-web.sidebar-width',
  sidebarViewMode: 'kimi-web.sidebar-view-mode',
  // Desktop-only custom keyboard shortcuts (docs/native-todos.md): action id →
  // canonical binding (null = unassigned; absent = default). lib/keymap.ts.
  shortcutOverrides: 'kimi-web.shortcut-overrides',
  // Desktop-only Dock icon preference: 'light' | 'dark' | 'auto' (default).
  // lib/dockIconChoice.ts.
  dockIconChoice: 'kimi-web.dock-icon-choice',
  // Desktop auto-update: version the user chose to skip (renderer-local).
  updateSkippedVersion: 'kimi-web.update-skipped-version',
  // deprecated cleanups (kept so the removals still fire for old users)
  // planMode mirrored the daemon FACT pre-intent; the armed intent now lives
  // in planArmed and the fact re-folds from /status — never load the old map.
  planMode: 'kimi-web.plan-mode',
  codeFont: 'kimi-web.code-font',
  contentAlign: 'kimi-web.content-align',
  theme: 'kimi-web.theme',
  thinking: 'kimi-web.thinking',
  accent: 'kimi-web.accent',
  notifyOnComplete: 'kimi-web.notify-on-complete',
  notifyOnQuestion: 'kimi-web.notify-on-question',
  notifyOnApproval: 'kimi-web.notify-on-approval',
  soundOnComplete: 'kimi-web.sound-on-complete',
} as const;

/** Per-session composer draft key. */
export function draftStorageKey(sid: string | undefined): string {
  return `kimi-web.draft.${sid && sid.length > 0 ? sid : '__new__'}`;
}

export function safeGetString(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetString(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode, quota, etc.) — ignore
  }
}

export function safeRemove(key: string): void {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function safeGetJson<T>(key: string): T | null {
  const raw = safeGetString(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function safeSetJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

/**
 * Per-session unread flags: a session id is "unread" when its value is `true`.
 * Persisted as a compact map of only the `true` entries (cleared sessions are
 * dropped). Backed by a single localStorage key so the sidebar's unread dots
 * survive a page refresh — there is no server-side read cursor.
 */
export function loadUnread(): Record<string, boolean> {
  const raw = safeGetString(STORAGE_KEYS.unread);
  if (!raw) return {};
  try {
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

/**
 * Apply a partial set of unread changes on top of the latest stored value.
 * Passing only the changed entries (rather than a full in-memory map) is what
 * keeps a clear that landed from another tab from being overwritten by this
 * tab's stale state. A `true` entry marks the session unread; a `false` entry
 * deletes the key (clearing the unread dot).
 */
export function saveUnread(changes: Record<string, boolean>): void {
  const current = loadUnread();
  const merged: Record<string, boolean> = { ...current };
  for (const [id, value] of Object.entries(changes)) {
    if (value) merged[id] = true;
    else delete merged[id];
  }
  safeSetString(STORAGE_KEYS.unread, JSON.stringify(merged));
}

/**
 * Collapsed workspace ids in the sidebar. Persisted as a JSON array of ids so
 * the fold state of each workspace group survives a page refresh. There is no
 * server-side source of truth for this UI-only state.
 */
export function loadCollapsedWorkspaces(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.collapsedWorkspaces);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === 'string');
}

export function saveCollapsedWorkspaces(ids: Iterable<string>): void {
  safeSetJson(STORAGE_KEYS.collapsedWorkspaces, Array.from(ids));
}

/**
 * Fold state of the sidebar's pinned section (PinnedSessionList). UI-only,
 * no server-side source of truth — same rationale as collapsedWorkspaces.
 */
export function loadPinnedCollapsed(): boolean {
  return safeGetJson<boolean>(STORAGE_KEYS.pinnedCollapsed) === true;
}

export function savePinnedCollapsed(collapsed: boolean): void {
  safeSetJson(STORAGE_KEYS.pinnedCollapsed, collapsed);
}

export type SidebarViewMode = 'flat' | 'grouped';

/**
 * Sidebar session-list display: 'grouped' (by workspace — the default) or
 * 'flat' (all sessions across workspaces, newest first). Since the status
 * tabs (open/done/workspaces) became the sidebar's top level, this is the
 * display switch INSIDE the open/done tabs, not a parallel view. UI-only, no
 * server-side source of truth — same rationale as collapsedWorkspaces.
 */
export function loadSidebarViewMode(): SidebarViewMode {
  return safeGetString(STORAGE_KEYS.sidebarViewMode) === 'flat' ? 'flat' : 'grouped';
}

export function saveSidebarViewMode(mode: SidebarViewMode): void {
  safeSetString(STORAGE_KEYS.sidebarViewMode, mode);
}

/**
 * Display order of workspace ids in the sidebar. Persisted as a JSON array so
 * the user can drag workspaces into a custom order that survives a page
 * refresh. There is no server-side source of truth for this UI-only ordering;
 * workspaces absent from the list are treated as "not yet placed" and inserted
 * by the caller (newest first).
 */
export function loadWorkspaceOrder(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.workspaceOrder);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === 'string');
}

export function saveWorkspaceOrder(ids: Iterable<string>): void {
  safeSetJson(STORAGE_KEYS.workspaceOrder, Array.from(ids));
}

/**
 * Sidebar workspace sort mode: 'manual' (the user's dragged order — the
 * default) or 'recent' (groups follow their latest session activity). UI-only,
 * no server-side source of truth — same rationale as workspaceOrder. The key
 * string predates the mode's 2026-07 removal; reviving it restores the old
 * preference for anyone who still has it stored.
 */
export function loadWorkspaceSort(): WorkspaceSortMode {
  return safeGetString(STORAGE_KEYS.workspaceSort) === 'recent' ? 'recent' : 'manual';
}

export function saveWorkspaceSort(mode: WorkspaceSortMode): void {
  safeSetString(STORAGE_KEYS.workspaceSort, mode);
}

/**
 * Per-workspace recency floor (id → epoch ms) backing the 'recent' sort mode.
 * Monotonic — only ever advances while a workspace lives — so archiving or
 * deleting a group's anchor session does not reshuffle the sidebar; another
 * group still overtakes it on real new activity. Persisted so the ordering
 * survives a refresh; entries are dropped when the workspace is removed.
 */
export function loadWorkspaceRecencyFloor(): Record<string, number> {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.workspaceRecencyFloor);
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
  }
  return out;
}

export function saveWorkspaceRecencyFloor(floor: Record<string, number>): void {
  safeSetJson(STORAGE_KEYS.workspaceRecencyFloor, floor);
}

/**
 * Pinned session ids in the user's manual order. Persisted as a JSON array so
 * the pinned sidebar section and its drag order survive a page refresh. There
 * is no server-side source of truth for pinning (per-device by design); ids
 * whose sessions are archived or deleted are dropped by the client.
 */
export function loadPinnedSessions(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.pinnedSessions);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === 'string');
}

export function savePinnedSessions(ids: Iterable<string>): void {
  safeSetJson(STORAGE_KEYS.pinnedSessions, Array.from(ids));
}

/**
 * Local display-name overrides for workspaces the daemon cannot rename — today
 * that is derived workspaces (a cwd with sessions that was never explicitly
 * registered), which `PATCH /workspaces/:id` rejects with 404. Keyed by
 * workspace root (stable across the derived → registered transition) and
 * applied on top of the daemon list so the rename survives a refresh. Cleared
 * once the daemon accepts a rename for that root.
 */
export function loadWorkspaceNameOverrides(): Record<string, string> {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.workspaceNameOverrides);
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [root, name] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof name === 'string') out[root] = name;
  }
  return out;
}

export function saveWorkspaceNameOverrides(overrides: Record<string, string>): void {
  safeSetJson(STORAGE_KEYS.workspaceNameOverrides, overrides);
}
