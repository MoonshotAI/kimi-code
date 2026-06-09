/**
 * `IWorkspaceRegistry` — daemon-OWN workspace metadata store.
 *
 * **Responsibility**: maintain a tiny JSON record (`workspace.json`) inside
 * each agent-core wd-key bucket under `<KIMI_CODE_HOME>/sessions/<wd-key>/`.
 * The bucket itself is owned by agent-core (it holds `<sid>/` session
 * directories); the daemon co-locates a single sibling file to mark the
 * bucket as a registered workspace. There is no central registry index —
 * `list()` is just `readdir(sessions/)` + an `isDirectory && wd_` prefix
 * filter + a `readFile(workspace.json)` per candidate.
 *
 * **Storage layout**:
 *
 *   <homeDir>/sessions/
 *     <wd-key>/                       ← agent-core owns this dir
 *       workspace.json                ← daemon owns ONLY this file
 *       <session_id_1>/               ← agent-core owns; we just count them
 *       <session_id_2>/               ...
 *
 * **Workspace.json schema (v=1)**:
 *
 *   {
 *     "version": 1,
 *     "root": "/Users/foo/code/kimi-code",   // realpath() result
 *     "name": "kimi-code",                    // display name (basename default)
 *     "created_at": "2026-06-08T09:00:00.000Z",
 *     "last_opened_at": "2026-06-08T09:30:00.000Z"
 *   }
 *
 * **Idempotency**: `createOrTouch(root)` runs `realpath(root)`, computes
 * `encodeWorkDirKey(realRoot)`, and writes the JSON record. Calling it with
 * the same root only updates `last_opened_at` (and `name` if explicitly
 * provided). Same `root` → same wd-key → never duplicates.
 *
 * **Anti-corruption**: imports `node:fs/promises`, `node:path`, `node:os`,
 * agent-core (`encodeWorkDirKey`, `Disposable`, decorator, `resolveKimiHome`)
 * and the protocol `Workspace` type. ZERO SDK imports.
 *
 * # Errors
 *
 *   - `WorkspaceNotFoundError`       → routed to `40410 workspace.not_found`
 *   - `WorkspaceRootNotFoundError`   → routed to `40409 fs.path_not_found`
 *                                       (`POST /workspaces { root }` where
 *                                       root doesn't exist)
 *   - Other I/O errors               → routed to `50001 internal`
 */

import {
  Disposable,
  createDecorator,
} from '@moonshot-ai/agent-core';

import type { Workspace } from '@moonshot-ai/protocol';

/* -------------------------------------------------------------------------
 * Error sentinels
 * ----------------------------------------------------------------------- */

/** Unknown workspace_id. Routed to envelope `code: 40410`. */
export class WorkspaceNotFoundError extends Error {
  readonly workspaceId: string;
  constructor(workspaceId: string) {
    super(`workspace not found: ${workspaceId}`);
    this.name = 'WorkspaceNotFoundError';
    this.workspaceId = workspaceId;
  }
}

/**
 * `POST /workspaces { root }` where the root path does not exist on disk.
 * Routed to envelope `code: 40409 fs.path_not_found`.
 */
export class WorkspaceRootNotFoundError extends Error {
  readonly root: string;
  constructor(root: string) {
    super(`workspace root does not exist: ${root}`);
    this.name = 'WorkspaceRootNotFoundError';
    this.root = root;
  }
}

/* -------------------------------------------------------------------------
 * Service interface (DI decorator)
 * ----------------------------------------------------------------------- */

export interface WorkspacePatch {
  /** New display name; must be 1–100 chars (enforced upstream by Zod). */
  name?: string;
}

export interface IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  /** List all registered workspaces, newest `last_opened_at` first. */
  list(): Promise<Workspace[]>;

  /**
   * Look up a workspace by id (= `encodeWorkDirKey(root)`). Throws
   * `WorkspaceNotFoundError` when no `workspace.json` exists at that wd-key.
   */
  get(workspaceId: string): Promise<Workspace>;

  /**
   * Idempotent register-or-touch. Realpath-resolves `root` (throws
   * `WorkspaceRootNotFoundError` on ENOENT) and either:
   *
   *   - Creates a fresh `workspace.json` (when none exists) with
   *     `name = name ?? basename(realRoot)` and a freshly minted
   *     `created_at` / `last_opened_at`, OR
   *   - Touches `last_opened_at` on the existing record. The optional
   *     `name` override is IGNORED on touch — use `update()` to rename.
   *
   * Returns the up-to-date Workspace either way.
   */
  createOrTouch(root: string, name?: string): Promise<Workspace>;

  /** Rename. Throws `WorkspaceNotFoundError` when the id is unknown. */
  update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace>;

  /**
   * Idempotent unregister — unlinks ONLY `<wd-key>/workspace.json`. Leaves
   * the wd-key directory + all its session subdirectories on disk. Throws
   * `WorkspaceNotFoundError` when the id is unknown.
   */
  delete(workspaceId: string): Promise<void>;

  /**
   * Convenience for the sessions route layer: resolve the workspace's root
   * path. Equivalent to `(await get(id)).root`, just avoids the git probe.
   */
  resolveRoot(workspaceId: string): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWorkspaceRegistry = createDecorator<IWorkspaceRegistry>('workspaceRegistry');

/** Minimal abstract base — implementations should extend this Disposable. */
export abstract class WorkspaceRegistryBase extends Disposable implements IWorkspaceRegistry {
  readonly _serviceBrand: undefined;
  abstract list(): Promise<Workspace[]>;
  abstract get(workspaceId: string): Promise<Workspace>;
  abstract createOrTouch(root: string, name?: string): Promise<Workspace>;
  abstract update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace>;
  abstract delete(workspaceId: string): Promise<void>;
  abstract resolveRoot(workspaceId: string): Promise<string>;
}
