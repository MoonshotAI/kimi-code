
import type { WorkspaceSortMode } from './workspaceOrder';
import { workspaceRootKey } from './rootKey';

export const STORAGE_KEYS = {
  permission: 'kimi-web.permission',
  permissionBySession: 'kimi-web.permission-by-session',
  permissionExplicit: 'kimi-web.permission-explicit',
  permissionStickyAt: 'kimi-web.permission-sticky-at',
  permissionDaemonDefault: 'kimi-web.permission-daemon-default',
  activeWorkspace: 'kimi-active-workspace',
  planArmed: 'kimi-web.plan-armed',
  swarmMode: 'kimi-web.swarm-mode',
  towerMode: 'kimi-web.tower-mode',
  goalMode: 'kimi-web.goal-mode',
  fontScale: 'kimi-web.font-scale',
  fontPrefs: 'kimi-web.fonts',
  recentModels: 'kimi-web.recent-models',
  unread: 'kimi-web.unread',
  manualUnread: 'kimi-web.manual-unread',
  onboarded: 'kimi-web.onboarded',
  colorScheme: 'kimi-web.color-scheme',
  hiddenWorkspaces: 'kimi-web.hidden-workspaces',
  hiddenWorkspaceIds: 'kimi-web.hidden-workspace-ids',
  collapsedWorkspaces: 'kimi-web.collapsed-workspaces',
  workspaceOrder: 'kimi-web.workspace-order',
  workspaceSort: 'kimi-web.workspace-sort',
  workspaceRecencyFloor: 'kimi-web.workspace-recency-floor',
  pinnedSessions: 'kimi-web.pinned-sessions',
  pinnedWorkspaces: 'kimi-web.pinned-workspaces',
  pinnedOrder: 'kimi-web.pinned-order',
  pinnedCollapsed: 'kimi-web.pinned-collapsed',
  sessionsSectionCollapsed: 'kimi-web.sessions-section-collapsed',
  pinnedSessionDisplayMode: 'kimi-web.pinned-session-display-mode',
  workspaceNameOverrides: 'kimi-web.workspace-name-overrides',
  workspaceNameOverridesById: 'kimi-web.workspace-name-overrides-by-id',
  notifyEnabled: 'kimi-web.notify-enabled',
  notifySound: 'kimi-web.notify-sound',
  inputHistory: 'kimi-web.input-history',
  locale: 'kimi-locale',
  clientId: 'kimi-web.client-id',
  debug: 'kimi-web.debug',
  openInDefaultTarget: 'kimi-web.open-in.default-target',
  openInLastTarget: 'kimi-web.open-in.last-target',
  sidebarCollapsed: 'kimi-web.sidebar-collapsed',
  sidebarWidth: 'kimi-web.sidebar-width',
  sidebarViewMode: 'kimi-web.sidebar-view-mode',
  mobileSwitcherViewMode: 'kimi-web.mobile-switcher-view-mode',
  diffViewMode: 'kimi-web.diff-view-mode',
  sidebarPinnedHeight: 'kimi-web.sidebar-pinned-height',
  shortcutOverrides: 'kimi-web.shortcut-overrides',
  dockIconChoice: 'kimi-web.dock-icon-choice',
  updateSkippedVersion: 'kimi-web.update-skipped-version',
  canarySkippedVersion: 'kimi-web.canary-skipped-version',
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
  sessionInfoPanel: 'kimi-web.session-info-panel',
  contextInspector: 'kimi-web.context-inspector',
  browserTabTitle: 'kimi-web.browser-tab-title',
  worktreeSourceByWorkspace: 'kimi-web.worktree-source-by-workspace',
  worktreeUseRemoteByWorkspace: 'kimi-web.worktree-use-remote-by-workspace',
  worktreeDiskRemindedLevel: 'kimi-web.worktree-disk-reminded-level',
  sessionMentions: 'kimi-web.session-mentions',
} as const;

export const NEW_SESSION_SCOPE = '__new__';

export function composerSessionScope(sid: string | undefined): string {
  return sid && sid.length > 0 ? sid : NEW_SESSION_SCOPE;
}

export function draftStorageKey(sid: string | undefined): string {
  return `kimi-web.draft.${composerSessionScope(sid)}`;
}

export function attachmentDraftStorageKey(sid: string | undefined): string {
  return `kimi-web.attachment-draft.${composerSessionScope(sid)}`;
}

export function draftAttachmentsStorageKey(sid: string | undefined): string {
  return `kimi-web.draft-atts.${composerSessionScope(sid)}`;
}

export function draftSnapshotStorageKey(sid: string | undefined): string {
  return `kimi-web.draft-snapshot.${composerSessionScope(sid)}`;
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
  } catch {}
}

export function safeRemove(key: string): void {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {}
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
  } catch {}
}

export function loadUnread(key: string = STORAGE_KEYS.unread): Record<string, boolean> {
  const raw = safeGetString(key);
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

export function saveUnread(changes: Record<string, boolean>, key: string = STORAGE_KEYS.unread): void {
  const current = loadUnread(key);
  const merged: Record<string, boolean> = { ...current };
  for (const [id, value] of Object.entries(changes)) {
    if (value) merged[id] = true;
    else delete merged[id];
  }
  safeSetString(key, JSON.stringify(merged));
}

export function loadCollapsedWorkspaces(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.collapsedWorkspaces);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === 'string');
}

export function saveCollapsedWorkspaces(ids: Iterable<string>): void {
  safeSetJson(STORAGE_KEYS.collapsedWorkspaces, Array.from(ids));
}

export function loadPinnedCollapsed(): boolean {
  return safeGetJson<boolean>(STORAGE_KEYS.pinnedCollapsed) === true;
}

export function savePinnedCollapsed(collapsed: boolean): void {
  safeSetJson(STORAGE_KEYS.pinnedCollapsed, collapsed);
}

export function loadSessionsSectionCollapsed(): boolean {
  return safeGetJson<boolean>(STORAGE_KEYS.sessionsSectionCollapsed) === true;
}

export function saveSessionsSectionCollapsed(collapsed: boolean): void {
  safeSetJson(STORAGE_KEYS.sessionsSectionCollapsed, collapsed);
}

export type PinnedSessionDisplayMode = 'compact' | 'workspace';

export function loadPinnedSessionDisplayMode(): PinnedSessionDisplayMode {
  return safeGetString(STORAGE_KEYS.pinnedSessionDisplayMode) === 'workspace' ? 'workspace' : 'compact';
}

export function savePinnedSessionDisplayMode(mode: PinnedSessionDisplayMode): void {
  safeSetString(STORAGE_KEYS.pinnedSessionDisplayMode, mode);
}

export type SidebarViewMode = 'flat' | 'grouped';

export function loadSidebarViewMode(): SidebarViewMode {
  return safeGetString(STORAGE_KEYS.sidebarViewMode) === 'flat' ? 'flat' : 'grouped';
}

export function saveSidebarViewMode(mode: SidebarViewMode): void {
  safeSetString(STORAGE_KEYS.sidebarViewMode, mode);
}

export function loadMobileSwitcherViewMode(): SidebarViewMode {
  return safeGetString(STORAGE_KEYS.mobileSwitcherViewMode) === 'grouped' ? 'grouped' : 'flat';
}

export function saveMobileSwitcherViewMode(mode: SidebarViewMode): void {
  safeSetString(STORAGE_KEYS.mobileSwitcherViewMode, mode);
}

export type DiffViewMode = 'list' | 'tree';

export function loadDiffViewMode(): DiffViewMode {
  return safeGetString(STORAGE_KEYS.diffViewMode) === 'tree' ? 'tree' : 'list';
}

export function saveDiffViewMode(mode: DiffViewMode): void {
  safeSetString(STORAGE_KEYS.diffViewMode, mode);
}

export function loadSessionInfoPanelEnabled(): boolean {
  return safeGetJson<boolean>(STORAGE_KEYS.sessionInfoPanel) !== false;
}

export function saveSessionInfoPanelEnabled(enabled: boolean): void {
  safeSetJson(STORAGE_KEYS.sessionInfoPanel, enabled);
}

export type BrowserTabTitleToken = 'workspace' | 'session';

export interface BrowserTabTitleSegment {
  id: BrowserTabTitleToken;
  enabled: boolean;
}

export type BrowserTabTitleMode =
  | 'workspace-session'
  | 'session-workspace'
  | 'workspace'
  | 'session'
  | 'none';

export const DEFAULT_BROWSER_TAB_TITLE_SEGMENTS: readonly BrowserTabTitleSegment[] = [
  { id: 'workspace', enabled: true },
  { id: 'session', enabled: true },
];

function normalizeBrowserTabTitleSegments(parsed: unknown): BrowserTabTitleSegment[] {
  if (!Array.isArray(parsed)) return DEFAULT_BROWSER_TAB_TITLE_SEGMENTS.map((s) => ({ ...s }));
  const seen = new Set<BrowserTabTitleToken>();
  const out: BrowserTabTitleSegment[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    const enabled = (item as { enabled?: unknown }).enabled;
    if ((id === 'workspace' || id === 'session') && !seen.has(id) && typeof enabled === 'boolean') {
      seen.add(id);
      out.push({ id, enabled });
    }
  }
  for (const def of DEFAULT_BROWSER_TAB_TITLE_SEGMENTS) {
    if (!seen.has(def.id)) out.push({ ...def });
  }
  return out;
}

export function parseBrowserTabTitleSegments(raw: string | null): BrowserTabTitleSegment[] {
  if (!raw) return DEFAULT_BROWSER_TAB_TITLE_SEGMENTS.map((s) => ({ ...s }));
  try {
    return normalizeBrowserTabTitleSegments(JSON.parse(raw));
  } catch {
    return DEFAULT_BROWSER_TAB_TITLE_SEGMENTS.map((s) => ({ ...s }));
  }
}

export function loadBrowserTabTitleSegments(): BrowserTabTitleSegment[] {
  return normalizeBrowserTabTitleSegments(safeGetJson<unknown>(STORAGE_KEYS.browserTabTitle));
}

export function saveBrowserTabTitleSegments(segments: readonly BrowserTabTitleSegment[]): void {
  safeSetJson(STORAGE_KEYS.browserTabTitle, normalizeBrowserTabTitleSegments(segments));
}

export function formatBrowserTabTitleMode(
  segments: readonly BrowserTabTitleSegment[],
): BrowserTabTitleMode {
  const enabled = segments.filter((s) => s.enabled).map((s) => s.id);
  if (enabled.length === 2) {
    return enabled[0] === 'session' ? 'session-workspace' : 'workspace-session';
  }
  if (enabled.length === 1) {
    return enabled[0] === 'session' ? 'session' : 'workspace';
  }
  return 'none';
}

export function loadWorkspaceOrder(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.workspaceOrder);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === 'string');
}

export function saveWorkspaceOrder(ids: Iterable<string>): void {
  safeSetJson(STORAGE_KEYS.workspaceOrder, Array.from(ids));
}

export function loadWorkspaceSort(): WorkspaceSortMode {
  return safeGetString(STORAGE_KEYS.workspaceSort) === 'recent' ? 'recent' : 'manual';
}

export function saveWorkspaceSort(mode: WorkspaceSortMode): void {
  safeSetString(STORAGE_KEYS.workspaceSort, mode);
}

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

export function loadActiveWorkspace(): string | null {
  try {
    return safeGetString(STORAGE_KEYS.activeWorkspace);
  } catch {
    return null;
  }
}

export function saveActiveWorkspace(id: string): void {
  try {
    safeSetString(STORAGE_KEYS.activeWorkspace, id);
  } catch {}
}

export function loadHiddenWorkspaceIds(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.hiddenWorkspaceIds);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === 'string');
}

export function saveHiddenWorkspaceIds(ids: string[]): void {
  safeSetJson(STORAGE_KEYS.hiddenWorkspaceIds, ids);
}

export function loadPinnedSessions(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.pinnedSessions);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === 'string');
}

export function savePinnedSessions(ids: Iterable<string>): void {
  safeSetJson(STORAGE_KEYS.pinnedSessions, Array.from(ids));
}

export function loadPinnedWorkspaces(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.pinnedWorkspaces);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === 'string');
}

export function savePinnedWorkspaces(ids: Iterable<string>): void {
  safeSetJson(STORAGE_KEYS.pinnedWorkspaces, Array.from(ids));
}

export function loadPinnedOrder(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.pinnedOrder);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (key): key is string =>
      typeof key === 'string' && (key.startsWith('ws:') || key.startsWith('session:')),
  );
}

export function savePinnedOrder(keys: Iterable<string>): void {
  safeSetJson(STORAGE_KEYS.pinnedOrder, Array.from(keys));
}

export function loadWorkspaceNameOverridesById(): Record<string, string> {
  const parsed = safeGetJson<unknown>(STORAGE_KEYS.workspaceNameOverridesById);
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof name === 'string') out[id] = name;
  }
  return out;
}

export function saveWorkspaceNameOverridesById(overrides: Record<string, string>): void {
  safeSetJson(STORAGE_KEYS.workspaceNameOverridesById, overrides);
}

export interface WorkspaceLocalOverridesMigration {
  hiddenWorkspaceIds: string[];
  nameOverrides: Record<string, string>;
}

export function migrateWorkspaceLocalOverrides(
  workspaces: readonly { id: string; root: string }[],
): WorkspaceLocalOverridesMigration | null {
  const legacyHidden = safeGetJson<unknown>(STORAGE_KEYS.hiddenWorkspaces);
  const legacyOverrides = safeGetJson<unknown>(STORAGE_KEYS.workspaceNameOverrides);
  if (legacyHidden === null && legacyOverrides === null) return null;
  const idByRootKey = new Map<string, string>();
  for (const w of workspaces) {
    const key = workspaceRootKey(w.root);
    if (!idByRootKey.has(key)) idByRootKey.set(key, w.id);
  }
  let hidden = loadHiddenWorkspaceIds();
  if (legacyHidden !== null) {
    if (Array.isArray(legacyHidden)) {
      const mapped = legacyHidden
        .filter((root): root is string => typeof root === 'string')
        .map((root) => idByRootKey.get(workspaceRootKey(root)))
        .filter((id): id is string => id !== undefined);
      if (mapped.length > 0) hidden = [...new Set([...hidden, ...mapped])];
    }
    safeRemove(STORAGE_KEYS.hiddenWorkspaces);
    saveHiddenWorkspaceIds(hidden);
  }
  let overrides = loadWorkspaceNameOverridesById();
  if (legacyOverrides !== null) {
    if (typeof legacyOverrides === 'object' && !Array.isArray(legacyOverrides)) {
      let changed = false;
      const next = { ...overrides };
      for (const [root, name] of Object.entries(legacyOverrides as Record<string, unknown>)) {
        if (typeof name !== 'string') continue;
        const id = idByRootKey.get(workspaceRootKey(root));
        if (id === undefined) continue;
        next[id] = name;
        changed = true;
      }
      if (changed) overrides = next;
    }
    safeRemove(STORAGE_KEYS.workspaceNameOverrides);
    saveWorkspaceNameOverridesById(overrides);
  }
  return { hiddenWorkspaceIds: hidden, nameOverrides: overrides };
}
