/**
 * `IFileStore` — daemon-OWN files store.
 *
 * **Responsibility**: persist uploaded blobs under `<KIMI_CODE_HOME>/files/`
 * (defaults to `~/.kimi-code/files/`; overridable via `KIMI_CODE_HOME` env),
 * maintain a JSON index of `FileMeta` records, and
 * serve them back by `file_id` for download / delete. Streams writes (no
 * in-memory buffering) and enforces the 50MB size cap DURING the streaming
 * write — abort on overrun, then delete the partial blob.
 *
 * **Daemon-OWN distinction**: like `IFsService` / `IFsWatcher`, the
 * store is NOT a thin wrapper around an `ICoreProcessService` call.
 * agent-core has no upload surface; the wire path directly addresses
 * the local filesystem. Lives in `packages/daemon`.
 *
 * # Storage layout
 *
 *   <homeDir>/files/<file_id>           # blob (raw bytes)
 *   <homeDir>/files/index.json          # array of FileMeta
 *
 * `homeDir` comes from `@IEnvironmentService.homeDir` so tests can
 * isolate the store by mocking the environment service.
 *
 * The index is read once into memory on first access (lazy) and
 * written-on-mutate. The blob file is the source of truth for bytes;
 * the index is the source of truth for metadata. If the two get out of
 * sync (e.g. a stray blob without an index entry, or vice versa) we
 * log a warning at load time and let the next mutation reconcile.
 *
 * # Errors
 *
 *   - `FileNotFoundError`  → routed to `40407 file.not_found`.
 *   - `FileTooLargeError`  → routed to `41301 file.too_large` (>50MB).
 *   - Other I/O errors    → routed to `50001 internal`.
 *
 * # Size cap (50MB) enforcement
 *
 * The route handler streams the multipart `file` field directly into
 * `fs.createWriteStream(blobPath)`. We attach a `'data'` listener that
 * tracks `bytesWritten` and aborts the write (closing both streams +
 * unlinking the partial blob) on overrun. The route translates the
 * abort signal to `FileTooLargeError`.
 *
 * # Anti-corruption
 *
 * Imports `node:fs`, `node:path`, `node:os`, `node:crypto`,
 * `node:stream/promises`, agent-core (`Disposable` + decorator), and the
 * protocol `FileMeta` type. ZERO SDK imports.
 */

import { createWriteStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { ulid } from 'ulid';

import {
  Disposable,
  createDecorator,
  resolveKimiHome,
} from '@moonshot-ai/agent-core';

import type { FileMeta } from '@moonshot-ai/protocol';

import { ILogService } from '#/services/logger';

/* -------------------------------------------------------------------------
 * Tunable constants
 * ----------------------------------------------------------------------- */

/** REST.md §3.10 upload cap (50 MB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/* -------------------------------------------------------------------------
 * Error sentinels
 * ----------------------------------------------------------------------- */

/** Thrown when `file_id` doesn't exist in the index. Mapped to 40407. */
export class FileNotFoundError extends Error {
  readonly fileId: string;
  constructor(fileId: string) {
    super(`file not found: ${fileId}`);
    this.name = 'FileNotFoundError';
    this.fileId = fileId;
  }
}

/**
 * Thrown when a streaming upload would exceed `maxUploadBytes`. The
 * route layer maps this to envelope `code: 41301 file.too_large`.
 *
 * On throw, the implementation MUST have already aborted the
 * underlying writes and unlinked the partial blob — callers don't need
 * to clean up.
 */
export class FileTooLargeError extends Error {
  readonly limit: number;
  readonly seen: number;
  constructor(seen: number, limit: number) {
    super(`upload size ${seen} bytes exceeds limit ${limit} bytes`);
    this.name = 'FileTooLargeError';
    this.seen = seen;
    this.limit = limit;
  }
}

/* -------------------------------------------------------------------------
 * Service interface (DI decorator)
 * ----------------------------------------------------------------------- */

export interface SaveOptions {
  /** Daemon-side filename override (multipart `name` field). */
  name?: string;
  /** Multipart `mimetype`; defaults to `application/octet-stream`. */
  mimeType?: string;
  /** Optional expiry seconds. */
  expiresInSec?: number;
}

export interface GetResult {
  meta: FileMeta;
  blobPath: string;
}

export interface IFileStore {
  readonly _serviceBrand: undefined;

  /**
   * Stream `source` to disk under a fresh `file_id`. Enforces the size
   * cap during streaming; throws `FileTooLargeError` on overrun and
   * leaves NO partial blob on disk. Returns the persisted FileMeta.
   *
   * `filename` is preserved verbatim (used for `Content-Disposition`).
   */
  save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;

  /**
   * Look up by `file_id`. Throws `FileNotFoundError` if absent. The
   * returned `blobPath` is suitable for `fs.createReadStream`.
   */
  get(fileId: string): Promise<GetResult>;

  /**
   * Idempotent delete. Throws `FileNotFoundError` if `file_id` is
   * not present (per REST.md §3.10 — `DELETE` returns 40407 for
   * unknown ids).
   */
  delete(fileId: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFileStore = createDecorator<IFileStore>('fileStore');

/* -------------------------------------------------------------------------
 * Implementation
 * ----------------------------------------------------------------------- */

interface IndexFile {
  version: 1;
  files: FileMeta[];
}


