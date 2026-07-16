// apps/kimi-web/src/lib/workspaceHint.ts
// Host-provided workspace binding for embedded hosts (the VS Code extension
// view). Such a host loads the web UI with its own workspace folders in the
// iframe URL:
//
//   ?workspace=<id-or-root>          the pinned (initially selected) workspace
//   &folder=<root>&folder=<root>...  the full workspace allow-list, in the
//                                    host's display order (repeatable param)
//
// The UI then pins its initial selection to `workspace` (falling back to the
// first folder) and focuses every workspace listing (sidebar groups, pickers,
// per-workspace session loading) on exactly those folders, in that order.
// Without any params the normal multi-workspace browser UI is unaffected.
//
// The query string is read once and mirrored to sessionStorage — mirroring the
// desktop-flag pattern (lib/desktopFlag.ts) — because in-app session routing
// rewrites the URL (dropping the query) and dev overlays reload it, either of
// which would otherwise lose the binding.

const PIN_QUERY_KEY = 'workspace';
const FOLDERS_QUERY_KEY = 'folder';
const PIN_STORAGE_KEY = 'kimi-workspace-hint';
const FOLDERS_STORAGE_KEY = 'kimi-workspace-folders';

function readQueryParams(): URLSearchParams | null {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    // window.location unavailable (tests, sandboxed contexts).
    return null;
  }
}

function readSessionStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable — query values still apply for this session.
  }
}

function detectPin(params: URLSearchParams | null): string | null {
  const fromQuery = params?.get(PIN_QUERY_KEY) ?? null;
  if (fromQuery !== null && fromQuery.trim() !== '') {
    writeSessionStorage(PIN_STORAGE_KEY, fromQuery);
    return fromQuery;
  }
  return readSessionStorage(PIN_STORAGE_KEY);
}

function parseFolders(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item !== '');
  } catch {
    return [];
  }
}

function detectFolders(params: URLSearchParams | null): string[] {
  const fromQuery = params !== null ? params.getAll(FOLDERS_QUERY_KEY).filter((f) => f !== '') : [];
  if (fromQuery.length > 0) {
    writeSessionStorage(FOLDERS_STORAGE_KEY, JSON.stringify(fromQuery));
    return fromQuery;
  }
  return parseFolders(readSessionStorage(FOLDERS_STORAGE_KEY));
}

// Resolved once per call (cheap) so tests can stub `location.search`; the
// sessionStorage mirrors keep both values after in-app URL rewrites.
function resolve(): { pin: string | null; folders: string[] } {
  if (typeof window === 'undefined') return { pin: null, folders: [] };
  const params = readQueryParams();
  return { pin: detectPin(params), folders: detectFolders(params) };
}

/** The host's pinned workspace (id OR absolute root), or null when the host
 *  only supplied a folder list (or for the normal browser UI). */
export function getWorkspaceHostHint(): string | null {
  return resolve().pin;
}

/** The host's workspace folders, in the host's display order ([] when absent). */
export function getWorkspaceHostFolders(): string[] {
  return resolve().folders;
}

/**
 * The ordered workspace allow-list the host bound the UI to: the folder list
 * when present, otherwise the single pinned workspace, otherwise empty (plain
 * browser UI — no focusing).
 */
export function getWorkspaceHostRoots(): string[] {
  const { pin, folders } = resolve();
  if (folders.length > 0) return folders;
  return pin !== null ? [pin] : [];
}

/** The initially selected workspace: the explicit pin, else the first folder. */
export function getWorkspaceHostPin(): string | null {
  const { pin, folders } = resolve();
  return pin ?? folders[0] ?? null;
}

/** True when the UI is bound to a host workspace set (embedded hosts such as
 *  the VS Code extension view). The workspace set is then fixed by the host —
 *  add/remove-workspace entry points should stay hidden. */
export function hasWorkspaceHostBinding(): boolean {
  return getWorkspaceHostRoots().length > 0;
}

/** True when the host bound the UI to exactly one workspace. The sidebar then
 *  renders a flat session list: the single group header (and its folding) is
 *  redundant chrome, and the workspace cannot be removed anyway. */
export function hasSingleWorkspaceHostBinding(): boolean {
  return getWorkspaceHostRoots().length === 1;
}

/** True when the workspace is within the host's allow-list (by id or root). */
export function workspaceMatchesHostRoots(workspace: { id: string; root: string }): boolean {
  return getWorkspaceHostRoots().some(
    (root) => workspace.id === root || workspace.root === root,
  );
}

/**
 * Focus a workspace list on the host's allow-list, ordered by it. Falls back
 * to the unfiltered list when there is no binding or when nothing matches
 * (e.g. the hinted workspace is not registered yet), so a dead hint never
 * blanks the sidebar.
 */
export function focusWorkspacesForHint<T extends { id: string; root: string }>(
  workspaces: T[],
): T[] {
  const roots = getWorkspaceHostRoots();
  if (roots.length === 0) return workspaces;
  const orderOf = (workspace: T): number =>
    roots.findIndex((root) => workspace.id === root || workspace.root === root);
  const matched = workspaces
    .map((workspace, index) => ({ workspace, index, order: orderOf(workspace) }))
    .filter((entry) => entry.order >= 0)
    .toSorted((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.workspace);
  return matched.length > 0 ? matched : workspaces;
}
