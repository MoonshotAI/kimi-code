/**
 * `workspaces.json` file format and atomic access — the on-disk contract of
 * the known-workspaces catalog, shared by `WorkspaceRegistryService` (the
 * services-layer facade, which adds locking and events on top) and by
 * in-process runtime callers that only need a best-effort touch (e.g.
 * `KimiCore` registering the cwd on session creation). It lives next to
 * `session-index.ts` because the runtime must not import back into
 * `services/` (see `src/services/AGENTS.md`).
 *
 * The layout is the v1-compatible `{ version, workspaces, deleted_workspace_ids }`
 * document at `<homeDir>/workspaces.json`; agent-core-v2 reads and writes the
 * same file, so both engines must agree on this shape.
 */

import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { basename as posixBasename } from 'pathe';

import { encodeWorkDirKey, normalizeWorkDir, workspaceRootKey } from '#/session/store/workdir-key';

const WORKSPACE_REGISTRY_FILE = 'workspaces.json';
const WORKSPACE_REGISTRY_VERSION = 1;

export interface WorkspaceRegistryEntry {
  root: string;
  name: string;
  created_at: string;
  last_opened_at: string;
}

export interface WorkspaceRegistryFile {
  version: number;
  workspaces: Record<string, WorkspaceRegistryEntry>;
  /** Workspace ids the user explicitly removed. Their session buckets stay on
   *  disk, so derived workspaces (computed from the session index) must skip
   *  them to keep deletion durable. */
  deleted_workspace_ids: string[];
}

/** Diagnostic hook for malformed-content warnings; `(context, message)`. */
export type WorkspaceRegistryWarn = (context: object, message: string) => void;

function emptyRegistryFile(): WorkspaceRegistryFile {
  return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {}, deleted_workspace_ids: [] };
}

/** Read `<homeDir>/workspaces.json`, tolerating a missing or malformed file
 *  (both yield an empty catalog). Unknown fields are ignored; entries failing
 *  sanitization are dropped. */
export async function readWorkspaceRegistryFile(
  homeDir: string,
  warn?: WorkspaceRegistryWarn,
): Promise<WorkspaceRegistryFile> {
  const registryPath = join(homeDir, WORKSPACE_REGISTRY_FILE);
  let raw: string;
  try {
    raw = await fsp.readFile(registryPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return emptyRegistryFile();
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn?.({ path: registryPath, err: String(err) }, 'workspaces.json malformed; treating as empty');
    return emptyRegistryFile();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { workspaces?: unknown }).workspaces !== 'object' ||
    (parsed as { workspaces?: unknown }).workspaces === null
  ) {
    warn?.({ path: registryPath }, 'workspaces.json missing required keys; treating as empty');
    return emptyRegistryFile();
  }
  const rawWorkspaces = (parsed as { workspaces: Record<string, unknown> }).workspaces;
  const workspaces: Record<string, WorkspaceRegistryEntry> = {};
  for (const [id, value] of Object.entries(rawWorkspaces)) {
    const entry = sanitizeWorkspaceRegistryEntry(value);
    if (entry !== null) {
      workspaces[id] = entry;
    }
  }
  const version =
    typeof (parsed as { version?: unknown }).version === 'number'
      ? (parsed as { version: number }).version
      : WORKSPACE_REGISTRY_VERSION;
  const rawDeleted = (parsed as { deleted_workspace_ids?: unknown }).deleted_workspace_ids;
  const deleted_workspace_ids = Array.isArray(rawDeleted)
    ? rawDeleted.filter((id): id is string => typeof id === 'string')
    : [];
  return { version, workspaces, deleted_workspace_ids };
}

/** Atomically write `<homeDir>/workspaces.json` (tmp file + rename). */
export async function writeWorkspaceRegistryFile(
  homeDir: string,
  file: WorkspaceRegistryFile,
): Promise<void> {
  const registryPath = join(homeDir, WORKSPACE_REGISTRY_FILE);
  await fsp.mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
  const tmp = `${registryPath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
  await fsp.rename(tmp, registryPath);
}

/**
 * Best-effort read-modify-write: register `root` in `<homeDir>/workspaces.json`
 * (or bump its `last_opened_at` when already present). An explicit touch clears
 * any prior deletion tombstone for the workspace id.
 *
 * Unlike `WorkspaceRegistryService.createOrTouch` this performs no
 * root-existence check and publishes no events; callers must treat failures as
 * non-fatal (the catalog is a hint, not session state). Concurrent writers in
 * other processes cannot corrupt the file (atomic rename), though a lost
 * update is possible — the next session-index merge heals missing entries.
 *
 * Identity folding matches the service: a spelling that only case/slash-differs
 * from an existing entry's root (e.g. `c:\Foo` after `C:\Foo` was added)
 * touches THAT entry instead of minting a duplicate. Without this the session
 * store's `resolveWorkspaceId` would split buckets again — the minted alias id
 * becomes the preferred id on the next create.
 */
export async function touchWorkspaceRegistry(
  homeDir: string,
  root: string,
  name?: string,
): Promise<{ workspaceId: string; created: boolean }> {
  const normalizedRoot = normalizeWorkDir(root);
  const mintedId = encodeWorkDirKey(normalizedRoot);
  const now = new Date().toISOString();
  const file = await readWorkspaceRegistryFile(homeDir);
  let workspaceId = mintedId;
  let existing = file.workspaces[mintedId];
  if (existing === undefined) {
    const rootKey = workspaceRootKey(normalizedRoot);
    const aliasId = Object.keys(file.workspaces).find(
      (id) => workspaceRootKey(file.workspaces[id]!.root) === rootKey,
    );
    if (aliasId !== undefined) {
      workspaceId = aliasId;
      existing = file.workspaces[aliasId];
    }
  }
  file.workspaces[workspaceId] =
    existing !== undefined
      ? { ...existing, last_opened_at: now }
      : {
          root: normalizedRoot,
          name: name ?? posixBasename(normalizedRoot),
          created_at: now,
          last_opened_at: now,
        };
  file.deleted_workspace_ids = file.deleted_workspace_ids.filter((id) => id !== workspaceId);
  await writeWorkspaceRegistryFile(homeDir, file);
  return { workspaceId, created: existing === undefined };
}

function sanitizeWorkspaceRegistryEntry(value: unknown): WorkspaceRegistryEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<WorkspaceRegistryEntry>;
  if (
    typeof v.root !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.created_at !== 'string' ||
    typeof v.last_opened_at !== 'string'
  ) {
    return null;
  }
  return {
    root: v.root,
    name: v.name,
    created_at: v.created_at,
    last_opened_at: v.last_opened_at,
  };
}
