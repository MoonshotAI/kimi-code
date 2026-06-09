/**
 * `IFsSearchService` — daemon-OWN filename search + content grep.
 *
 * **Daemon-OWN** distinction: there is no agent-core `search` / `grep`
 * surface. We implement against Node primitives
 * (`fs.promises` + optional `child_process.spawn('rg', ...)`) and live in the
 * daemon package.
 *
 * Endpoints (REST.md §3.9):
 *
 *   search(sessionId, request)        → FsSearchResponse
 *   grep(sessionId, request)          → FsGrepResponse
 *
 * **Path safety**: every `path` input is funnelled through
 * `resolveSafePath(cwd, input)` from `fsPathSafety.ts` BEFORE any Node `fs`
 * call. We never expose absolute paths to the wire; results carry POSIX
 * relative paths anchored at `session.metadata.cwd`.
 *
 * **rg detection**: we shell out `which rg` ONCE
 * at construction time and cache the result. If `rg` is missing, every grep
 * call falls back to a pure-Node implementation and the FIRST such call
 * emits a single WARN log line via `ILogService`. We don't re-warn on later
 * calls (the warning is informational, not actionable — repeating it would
 * just spam).
 *
 * **rg fallback semantics**:
 *   - search: pure-Node always (rg's `--files` is faster on large repos
 *     but search results are filename-only, which is cheap enough
 *     with a simple recursive walk). Using one impl for both presence and
 *     absence of rg makes the test matrix smaller.
 *   - grep: rg preferred; fallback walks every `.gitignore`-allowed file
 *     under cwd and runs `RegExp.exec` per line.
 *
 * **30s timeout**: grep enforces a 30s wall-clock
 * cap. We use `AbortController` to cancel the rg child (`child.kill('SIGKILL')`
 * on abort) AND to break the Node-fallback loop. Hitting the timeout
 * throws `FsGrepTimeoutError` → routes map to `41305 fs.grep_timeout`.
 *
 * **500-hit cap**: `:search` returns at most 500
 * items even if `limit > 500` is requested (the schema's max is 200, but
 * the daemon defends against future schema relaxation). When the cap is
 * hit, `truncated: true` is set.
 *
 * **Glob grammar** matches `fs.ts:globToRegExp` (supports `*`, `**`, `?`). We
 * reuse the helper via re-export rather than duplicating.
 *
 * **Anti-corruption**: this module imports `node:fs/promises`,
 * `node:path`, `node:child_process`, `ignore`, `ISessionService` from
 * `@moonshot-ai/services`, and the daemon's `ILogService` decorator. ZERO
 * imports from `@moonshot-ai/agent-core` other than the `createDecorator`
 * + `Disposable` DI primitives, and ZERO from the SDK package.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createDecorator,
  Disposable,
  type IDisposable,
} from '@moonshot-ai/agent-core';
import {
  ISessionService,
  SessionNotFoundError,
} from '@moonshot-ai/services';
import type {
  FsGrepFileHit,
  FsGrepMatch,
  FsGrepRequest,
  FsGrepResponse,
  FsSearchHit,
  FsSearchRequest,
  FsSearchResponse,
} from '@moonshot-ai/protocol';
import ignore, { type Ignore } from 'ignore';

import { ILogService } from '#/services/logger';
import {
  FsPathEscapesError,
  resolveSafePath,
} from './fsPathSafety';

// ---------------------------------------------------------------------------
// Error sentinels
// ---------------------------------------------------------------------------

export class FsGrepTimeoutError extends Error {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    super(`fs.grep_timeout after ${elapsedMs}ms`);
    this.name = 'FsGrepTimeoutError';
    this.elapsedMs = elapsedMs;
  }
}

// ---------------------------------------------------------------------------
// Public interface + decorator
// ---------------------------------------------------------------------------

export interface IFsSearchService extends IDisposable {
  readonly _serviceBrand: undefined;

  search(
    sessionId: string,
    req: FsSearchRequest,
  ): Promise<FsSearchResponse>;
  grep(sessionId: string, req: FsGrepRequest): Promise<FsGrepResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFsSearchService = createDecorator<IFsSearchService>(
  'fsSearchService',
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on `:search` items. */
const SEARCH_HARD_CAP = 500;
/** Wall-clock cap for `:grep` (REST.md §3.9 line 645). */
const GREP_TIMEOUT_MS = 30_000;
/** Hard cap on directory traversal depth — defensive (real repos cap below). */
const WALK_MAX_DEPTH = 64;

void FsPathEscapesError;
void SessionNotFoundError;
