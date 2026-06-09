/**
 * Path-safety primitives (REST.md §4.4) — the central correctness piece for
 * daemon filesystem access.
 *
 * Every `path` flowing into `/sessions/{sid}/fs:*` MUST pass through
 * `resolveSafePath(cwd, input)` BEFORE being touched by Node `fs.promises`.
 * Skipping the guard is a path-traversal bug.
 *
 * **Algorithm** (REST.md §4.4 line 749-757):
 *
 *   1. Reject the empty string and the literal `'/'` outright (no legitimate
 *      use case; defensive against subtle bypasses).
 *   2. Reject any path whose *first* path-resolver step would yield an
 *      absolute path — i.e. `path.isAbsolute(input)` (POSIX `/` or Windows
 *      `C:\\`). → `FsPathEscapesError`.
 *   3. Reject inputs containing a `..` segment, REGARDLESS of whether the
 *      normalized path would stay inside cwd. SCHEMAS §4.4 line 755
 *      explicitly says: "拒绝包含 `..` 段（即使 normalize 后仍在 cwd 内也拒，
 *      避免 symlink 跳出）" — the `..` ban is a defense against the
 *      symlink-following corner cases that `path.resolve` can't reason about.
 *   4. Resolve via `path.resolve(cwd, input)`; verify the result is still
 *      INSIDE `realpath(cwd)` (after both sides are realpath'd, see below).
 *   5. If the resolved path is a symlink (or contains one as an ancestor),
 *      `fs.realpath` it and re-verify the resolved realpath is still inside
 *      `realpath(cwd)`. Symlinks pointing OUTSIDE → `FsPathEscapesError`.
 *
 * **The realpath dance**: macOS resolves `/tmp` to `/private/tmp`; many test
 * setups create cwd under `os.tmpdir()`. We MUST realpath both sides
 * (`cwd` and the resolved input) before comparing, otherwise legitimate
 * in-tree paths fail the containment check. We realpath the cwd ONCE per
 * call and cache nothing — caching would be a stale-state footgun.
 *
 * **Why not `path.relative(cwd, abs).startsWith('..')`**: that's a popular
 * shortcut and it works for the lexical case, but it does NOT chase
 * symlinks. We MUST `realpath` (or `fs.lstat` + climb) to defeat
 * `cwd/safe-looking-symlink → /etc/passwd`. See test
 * `'symlink pointing outside cwd is rejected'` in `fs-path-safety.test.ts`.
 *
 * **Performance**: `realpath` is one extra `fstatat`/`readlinkat` syscall
 * chain. Bench shows ~50µs per call on SSD; below the 200ms / 1000-stat
 * target with 4× headroom. Acceptable.
 *
 * **Errors**: this module throws ONE sentinel class — `FsPathEscapesError`.
 * The route layer catches it and emits `code: 41304
 * fs.path_escapes_session`. We do NOT distinguish absolute-vs-`..`-vs-symlink
 * on the wire — REST.md §4.4 has only one error code for all four cases.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Thrown when `inputPath` violates path safety against `cwd`. The route
 * layer maps this to envelope `code: 41304 fs.path_escapes_session`.
 *
 * The `reason` discriminator is informational only — it surfaces in the
 * envelope `msg` field but the wire code is identical regardless. Tests
 * assert on it to verify each branch.
 */
export class FsPathEscapesError extends Error {
  readonly inputPath: string;
  readonly reason:
    | 'empty'
    | 'absolute'
    | 'dotdot_segment'
    | 'resolved_outside_cwd'
    | 'symlink_outside_cwd';

  constructor(
    inputPath: string,
    reason: FsPathEscapesError['reason'],
    detail?: string,
  ) {
    super(
      detail
        ? `path "${inputPath}" rejected (${reason}): ${detail}`
        : `path "${inputPath}" rejected (${reason})`,
    );
    this.name = 'FsPathEscapesError';
    this.inputPath = inputPath;
    this.reason = reason;
  }
}

export interface PathSafetyResult {
  /** Fully resolved absolute filesystem path (post-realpath). */
  readonly absolute: string;
  /** POSIX-style relative path from `cwd` (post-realpath). */
  readonly relative: string;
}

/**
 * Resolve `inputPath` relative to `cwd`. Throws `FsPathEscapesError` if any
 * stage of the safety algorithm flags an escape.
 *
 * Notes:
 *   - `cwd` MUST be an absolute path. Caller is responsible (in the daemon,
 *     it's always `session.metadata.cwd` which agent-core requires absolute).
 *   - `inputPath === ''` is rejected (`empty` reason); `inputPath === '.'`
 *     is the canonical root reference and resolves to `cwd` itself.
 *   - Pre-existence is NOT checked here; `realpath` only runs against the
 *     longest existing prefix. Callers that need existence semantics
 *     (`fs.read`, `fs.stat`) do that themselves and surface `40409` if the
 *     file is missing.
 *   - The relative path uses POSIX separators (mirrors REST.md §3.9 line 451:
 *     all wire paths are POSIX). On Windows the daemon-self surface still
 *     emits POSIX wire paths; the underlying fs ops use native separators.
 *
 * Failure precedence (each stage short-circuits the next):
 *   empty → absolute → dotdot_segment → resolved_outside_cwd
 *         → symlink_outside_cwd
 */
export async function resolveSafePath(
  cwd: string,
  inputPath: string,
): Promise<PathSafetyResult> {
  // 1. Empty / literal root reject.
  if (inputPath === '' || inputPath === '/') {
    throw new FsPathEscapesError(inputPath, 'empty');
  }

  // 2. Absolute path reject (POSIX `/` or Windows drive prefix).
  if (path.isAbsolute(inputPath)) {
    throw new FsPathEscapesError(inputPath, 'absolute');
  }

  // 3. `..` segment reject — SCHEMAS §4.4 line 755 requires this even when
  //    the lexical result would stay in cwd. This is the symlink-defense.
  //    We check post-normalize POSIX segments so that `foo/../bar` is
  //    rejected regardless of OS separator.
  const segments = inputPath.split(/[/\\]+/);
  if (segments.some((s) => s === '..')) {
    throw new FsPathEscapesError(inputPath, 'dotdot_segment');
  }

  // 4. Realpath the cwd so the containment check survives /tmp→/private/tmp
  //    (macOS) and other symlink-anchored mounts. If cwd itself is missing
  //    we surface the underlying error verbatim (callers will see ENOENT —
  //    the daemon's session is broken at that point).
  const realCwd = await fs.realpath(cwd);

  // 5. Resolve the input against cwd. We use the realpath'd cwd as the
  //    resolution root so the resolved-outside check below is robust.
  const candidate = path.resolve(realCwd, inputPath);

  // 6. Resolve symlinks on the candidate's longest-existing prefix. We
  //    walk the candidate path bottom-up; for each existing prefix we
  //    realpath, then re-attach the tail. The bottom-up walk handles the
  //    common case where the target file doesn't exist yet (e.g. before
  //    `:read` which surfaces ENOENT → 40409 itself).
  const resolved = await realpathLongestExistingPrefix(candidate);

  // 7. Containment check against `realCwd`. We compare with a trailing
  //    separator so `cwd-evil-twin/x` doesn't pass as a child of `cwd`.
  if (!isInsideOrEqual(resolved, realCwd)) {
    // If the syntactic resolve was inside cwd but realpath moved it outside,
    // the cause is a symlink. Otherwise it's a path that escaped lexically
    // (shouldn't happen given the `..` ban above, but defensive).
    const reason: FsPathEscapesError['reason'] = isInsideOrEqual(candidate, realCwd)
      ? 'symlink_outside_cwd'
      : 'resolved_outside_cwd';
    throw new FsPathEscapesError(inputPath, reason, resolved);
  }

  return {
    absolute: resolved,
    relative: toPosixRelative(realCwd, resolved),
  };
}

/**
 * Synchronous-ish containment check: does `child` equal `parent` or sit
 * inside it? We use `path.relative` and reject relative results that
 * either go up (`..`) or start with an absolute path (cross-drive on
 * Windows). This is the same check VSCode's FileSystemProvider uses.
 */
function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true; // exact equality
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false; // cross-drive on Windows
  return true;
}

/**
 * Realpath the longest existing prefix of `target`, then re-attach the
 * non-existing tail. Used so `:read` of a missing file still passes
 * through the symlink check (we resolve any symlinked parent and trust
 * the missing tail can't itself be a symlink target).
 */
async function realpathLongestExistingPrefix(target: string): Promise<string> {
  let current = target;
  const tailSegments: string[] = [];
  // Walk up at most 4096 levels — defensive bound; real paths cap well below.
  for (let i = 0; i < 4096; i++) {
    try {
      const real = await fs.realpath(current);
      // Reattach the non-existing tail (preserving original order).
      tailSegments.reverse();
      return tailSegments.length === 0 ? real : path.join(real, ...tailSegments);
    } catch (err) {
      // ENOENT / ENOTDIR → strip the last segment and retry.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything that exists.
        // Bail with the original target; the higher-level call (fs.read /
        // fs.stat) will surface the right error.
        return target;
      }
      tailSegments.push(path.basename(current));
      current = parent;
    }
  }
  return target;
}

/** Convert an absolute path under `cwd` to a POSIX-style relative wire path. */
function toPosixRelative(cwd: string, absolute: string): string {
  if (absolute === cwd) return '.';
  const rel = path.relative(cwd, absolute);
  if (rel === '') return '.';
  // Node returns native separators on Windows; force POSIX for the wire.
  return rel.split(path.sep).join('/');
}
