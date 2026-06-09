/**
 * `IWorkspaceFsService` — daemon-OWN folder picker backend.
 *
 * Powers `GET /api/v1/fs:browse` + `GET /api/v1/fs:home`. NOT to be confused
 * with `IFsService` (the session-scoped filesystem under `IFsService`
 * which enforces `resolveSafePath(cwd, input)`); the browser intentionally
 * has no cwd anchor — its job is to let the user pick an arbitrary absolute
 * directory to register as a workspace.
 *
 * # Endpoints
 *
 *   browse(absPath?)  → FsBrowseResponse  ({ path, parent, entries[] })
 *   home()            → FsHomeResponse    ({ home, recent_roots[] })
 *
 * # Errors
 *
 *   WorkspaceFsNotAbsoluteError    → 40001 validation.failed
 *   WorkspaceFsNotFoundError       → 40409 fs.path_not_found
 *   WorkspaceFsPermissionError     → 40411 fs.permission_denied
 *   Other I/O errors               → 50001 internal
 *
 * # Safety stance (intentional)
 *
 * - No path whitelist; the explicit contract is "whatever this daemon
 *   process can read".
 * - Only directories are surfaced (files are never returned); no file
 *   contents are read.
 * - Read-only; never writes / deletes.
 */

import { createDecorator, Disposable } from '@moonshot-ai/agent-core';

import type { FsBrowseResponse, FsHomeResponse } from '@moonshot-ai/protocol';

/* -------------------------------------------------------------------------
 * Error sentinels
 * ----------------------------------------------------------------------- */

/** `fs:browse?path=` was non-absolute. Routed to envelope `code: 40001`. */
export class WorkspaceFsNotAbsoluteError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path must be absolute: ${path}`);
    this.name = 'WorkspaceFsNotAbsoluteError';
    this.path = path;
  }
}

/** `path` does not exist / is not a directory. Routed to `40409`. */
export class WorkspaceFsNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path not found: ${path}`);
    this.name = 'WorkspaceFsNotFoundError';
    this.path = path;
  }
}

/** Permission denied while reading `path`. Routed to `40411`. */
export class WorkspaceFsPermissionError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`permission denied: ${path}`);
    this.name = 'WorkspaceFsPermissionError';
    this.path = path;
  }
}

/* -------------------------------------------------------------------------
 * Service interface (DI decorator)
 * ----------------------------------------------------------------------- */

export interface IWorkspaceFsService {
  readonly _serviceBrand: undefined;

  /**
   * List immediate subdirectories of `absPath` (or `$HOME` when undefined).
   * Realpath-resolves the input, then `readdir`. See module header for
   * error mapping.
   */
  browse(absPath?: string): Promise<FsBrowseResponse>;

  /**
   * Picker landing payload: home dir + the up-to-8 most recently opened
   * workspace roots (sourced from `IWorkspaceRegistry.list()`).
   */
  home(): Promise<FsHomeResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWorkspaceFsService = createDecorator<IWorkspaceFsService>(
  'workspaceFsService',
);

/** Disposable base — implementations should extend this. */
export abstract class WorkspaceFsBase
  extends Disposable
  implements IWorkspaceFsService
{
  readonly _serviceBrand: undefined;
  abstract browse(absPath?: string): Promise<FsBrowseResponse>;
  abstract home(): Promise<FsHomeResponse>;
}

/** Picker default cap on `recent_roots`. */
export const RECENT_ROOTS_LIMIT = 8;
