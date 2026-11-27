
import { UI_PREFERENCE_KEYS, type UiPreferenceKey } from '@moonshot-ai/kimi-code-product/ui-preferences';

import type { WorkspaceSortMode } from './workspaceOrder';
import { workspaceRootKey } from './rootKey';
import { uiPreferences } from './uiPreferences';
import { safeGetString, safeRemove, safeSetJson, safeSetString } from './safeStorage';

export { safeGetString, safeRemove, safeSetJson, safeSetString } from './safeStorage';

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

export function safeGetJson<T>(key: string): T | null {
  const raw = safeGetString(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface UiPreferenceBinding<T> {
  readonly key: UiPreferenceKey;
  readonly legacyKey: string;
  readonly legacy: 'json' | 'string';
  readonly decode: (value: unknown) => T | undefined;
  readonly fromLegacyString?: (raw: string) => unknown;
  readonly toLegacyString?: (value: T) => string;
}

function decodeStringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function decodeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function decodeOneOf<T extends string>(...allowed: readonly T[]): (value: unknown) => T | undefined {
  return (value) => ((allowed as readonly unknown[]).includes(value) ? (value as T) : undefined);
}

function decodeRecencyFloor(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
  }
  return out;
}

function decodePinnedOrder(value: unknown): string[] | undefined {
  return decodeStringList(value)?.filter((key) => key.startsWith('ws:') || key.startsWith('session:'));
}

function binding<T>(
  key: UiPreferenceKey,
  legacyKey: string,
  legacy: 'json' | 'string',
  decode: (value: unknown) => T | undefined,
  legacyString: Pick<UiPreferenceBinding<T>, 'fromLegacyString' | 'toLegacyString'> = {},
): UiPreferenceBinding<T> {
  return { key, legacyKey, legacy, decode, ...legacyString };
}

const PREF = {
  pinnedSessions: binding(UI_PREFERENCE_KEYS.sidebarPinnedSessions, STORAGE_KEYS.pinnedSessions, 'json', decodeStringList),
  pinnedWorkspaces: binding(UI_PREFERENCE_KEYS.sidebarPinnedWorkspaces, STORAGE_KEYS.pinnedWorkspaces, 'json', decodeStringList),
  pinnedOrder: binding(UI_PREFERENCE_KEYS.sidebarPinnedOrder, STORAGE_KEYS.pinnedOrder, 'json', decodePinnedOrder),
  workspaceOrder: binding(UI_PREFERENCE_KEYS.sidebarWorkspaceOrder, STORAGE_KEYS.workspaceOrder, 'json', decodeStringList),
  workspaceSort: binding(
    UI_PREFERENCE_KEYS.sidebarWorkspaceSort,
    STORAGE_KEYS.workspaceSort,
    'string',
    decodeOneOf<WorkspaceSortMode>('manual', 'recent'),
  ),
  workspaceRecencyFloor: binding(
    UI_PREFERENCE_KEYS.sidebarWorkspaceRecencyFloor,
    STORAGE_KEYS.workspaceRecencyFloor,
    'json',
    decodeRecencyFloor,
  ),
  hiddenWorkspaceIds: binding(UI_PREFERENCE_KEYS.sidebarHiddenWorkspaceIds, STORAGE_KEYS.hiddenWorkspaceIds, 'json', decodeStringList),
  collapsedWorkspaces: binding(UI_PREFERENCE_KEYS.sidebarCollapsedWorkspaces, STORAGE_KEYS.collapsedWorkspaces, 'json', decodeStringList),
  pinnedCollapsed: binding(UI_PREFERENCE_KEYS.sidebarPinnedCollapsed, STORAGE_KEYS.pinnedCollapsed, 'json', decodeBoolean),
  sessionsSectionCollapsed: binding(
    UI_PREFERENCE_KEYS.sidebarSessionsSectionCollapsed,
    STORAGE_KEYS.sessionsSectionCollapsed,
    'json',
    decodeBoolean,
  ),
  pinnedSessionDisplayMode: binding(
    UI_PREFERENCE_KEYS.sidebarPinnedSessionDisplayMode,
    STORAGE_KEYS.pinnedSessionDisplayMode,
    'string',
    decodeOneOf<PinnedSessionDisplayMode>('compact', 'workspace'),
  ),
  sidebarViewMode: binding(
    UI_PREFERENCE_KEYS.sidebarViewMode,
    STORAGE_KEYS.sidebarViewMode,
    'string',
    decodeOneOf<SidebarViewMode>('flat', 'grouped'),
  ),
  onboarded: binding(UI_PREFERENCE_KEYS.onboardingCompleted, STORAGE_KEYS.onboarded, 'string', decodeBoolean, {
    fromLegacyString: (raw) => (raw === '1' ? true : raw === '0' ? false : undefined),
    toLegacyString: (done) => (done ? '1' : '0'),
  }),
} as const;

function readLegacyPreference<T>(pref: UiPreferenceBinding<T>): T | undefined {
  if (pref.legacy === 'json') {
    const parsed = safeGetJson<unknown>(pref.legacyKey);
    return parsed === null ? undefined : pref.decode(parsed);
  }
  const raw = safeGetString(pref.legacyKey);
  if (raw === null) return undefined;
  return pref.decode(pref.fromLegacyString === undefined ? raw : pref.fromLegacyString(raw));
}

function readPreference<T>(pref: UiPreferenceBinding<T>): T | undefined {
  if (uiPreferences.mode !== 'server') return readLegacyPreference(pref);
  const value = uiPreferences.value(pref.key);
  return value === undefined ? undefined : pref.decode(value);
}

function writeLegacyPreference<T>(pref: UiPreferenceBinding<T>, value: T | undefined): void {
  if (value === undefined) safeRemove(pref.legacyKey);
  else if (pref.legacy === 'json') safeSetJson(pref.legacyKey, value);
  else safeSetString(pref.legacyKey, pref.toLegacyString === undefined ? String(value) : pref.toLegacyString(value));
}

function writePreference<T>(pref: UiPreferenceBinding<T>, value: T): void {
  if (uiPreferences.write(pref.key, value)) return;
  writeLegacyPreference(pref, value);
}

uiPreferences.onChange((keys) => {
  if (uiPreferences.mode !== 'server') return;
  const changed = new Set(keys);
  for (const pref of Object.values(PREF) as readonly UiPreferenceBinding<unknown>[]) {
    if (changed.has(pref.key)) writeLegacyPreference(pref, readPreference(pref));
  }
});

export function legacyUiPreferenceValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const pref of Object.values(PREF) as readonly UiPreferenceBinding<unknown>[]) {
    const value = readLegacyPreference(pref);
    if (value !== undefined) values[pref.key] = value;
  }
  return values;
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
  return readPreference(PREF.collapsedWorkspaces) ?? [];
}

export function saveCollapsedWorkspaces(ids: Iterable<string>): void {
  writePreference(PREF.collapsedWorkspaces, Array.from(ids));
}

export function loadPinnedCollapsed(): boolean {
  return readPreference(PREF.pinnedCollapsed) === true;
}

export function savePinnedCollapsed(collapsed: boolean): void {
  writePreference(PREF.pinnedCollapsed, collapsed);
}

export function loadSessionsSectionCollapsed(): boolean {
  return readPreference(PREF.sessionsSectionCollapsed) === true;
}

export function saveSessionsSectionCollapsed(collapsed: boolean): void {
  writePreference(PREF.sessionsSectionCollapsed, collapsed);
}

export type PinnedSessionDisplayMode = 'compact' | 'workspace';

export function loadPinnedSessionDisplayMode(): PinnedSessionDisplayMode {
  return readPreference(PREF.pinnedSessionDisplayMode) ?? 'compact';
}

export function savePinnedSessionDisplayMode(mode: PinnedSessionDisplayMode): void {
  writePreference(PREF.pinnedSessionDisplayMode, mode);
}

export type SidebarViewMode = 'flat' | 'grouped';

export function loadSidebarViewMode(): SidebarViewMode {
  return readPreference(PREF.sidebarViewMode) ?? 'grouped';
}

export function saveSidebarViewMode(mode: SidebarViewMode): void {
  writePreference(PREF.sidebarViewMode, mode);
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
  return readPreference(PREF.workspaceOrder) ?? [];
}

export function saveWorkspaceOrder(ids: Iterable<string>): void {
  writePreference(PREF.workspaceOrder, Array.from(ids));
}

export function loadWorkspaceSort(): WorkspaceSortMode {
  return readPreference(PREF.workspaceSort) ?? 'manual';
}

export function saveWorkspaceSort(mode: WorkspaceSortMode): void {
  writePreference(PREF.workspaceSort, mode);
}

export function loadWorkspaceRecencyFloor(): Record<string, number> {
  return readPreference(PREF.workspaceRecencyFloor) ?? {};
}

export function saveWorkspaceRecencyFloor(floor: Record<string, number>): void {
  writePreference(PREF.workspaceRecencyFloor, floor);
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
  return readPreference(PREF.hiddenWorkspaceIds) ?? [];
}

export function saveHiddenWorkspaceIds(ids: string[]): void {
  writePreference(PREF.hiddenWorkspaceIds, ids);
}

export function loadPinnedSessions(): string[] {
  return readPreference(PREF.pinnedSessions) ?? [];
}

export function savePinnedSessions(ids: Iterable<string>): void {
  writePreference(PREF.pinnedSessions, Array.from(ids));
}

export function loadPinnedWorkspaces(): string[] {
  return readPreference(PREF.pinnedWorkspaces) ?? [];
}

export function savePinnedWorkspaces(ids: Iterable<string>): void {
  writePreference(PREF.pinnedWorkspaces, Array.from(ids));
}

export function loadPinnedOrder(): string[] {
  return readPreference(PREF.pinnedOrder) ?? [];
}

export function savePinnedOrder(keys: Iterable<string>): void {
  writePreference(PREF.pinnedOrder, Array.from(keys));
}

export function loadOnboarded(): boolean {
  return readPreference(PREF.onboarded) === true;
}

export function saveOnboarded(done: boolean): void {
  writePreference(PREF.onboarded, done);
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
