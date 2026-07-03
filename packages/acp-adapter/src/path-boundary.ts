/**
 * Path-boundary primitives for the ACP `additionalDirectories` feature.
 *
 * The boundary check is the security-bearing layer behind
 * `AcpKaos.readText` / `writeText` / etc. — every file operation goes
 * through `assertPathInRoots` BEFORE the ACP reverse-RPC call, so a
 * model-side `Read /etc/passwd` cannot bypass the client's trust
 * boundary by hopping through the kernel's local filesystem.
 *
 * Three primitives:
 *
 *   {@link resolveCanonicalPath}
 *     Symlink-resolving canonicalisation for a target path. Handles
 *     the "path doesn't yet exist" case (writes to new files) by
 *     anchoring at the deepest existing ancestor.
 *
 *   {@link resolveCanonicalRoots}
 *     Realpath every supplied root at session-init time. Missing
 *     roots cause `KaosError` — this is the spec's fail-closed-at-
 *     creation guarantee.
 *
 *   {@link assertPathInRoots}
 *     Pre-flight check: target must canonicalise to a location
 *     inside one of the canonicalised roots, OR be exactly a root.
 *     Failure raises `KaosError` carrying the operation name.
 *
 * All primitives use `fs.realpath` so symlinks/junctions/mount points
 * are resolved before the prefix comparison — the prefix check would
 * otherwise miss escapes planted under a parent symlink.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { KaosError } from '@moonshot-ai/kaos';

/**
 * Resolve `p` to its canonical, symlink-resolved form.
 *
 * - If `p` exists, returns `fs.realpath(p)`.
 * - If `p` (or any parent) doesn't exist, walks up until it finds an
 *   existing ancestor, realpaths that, and reappends the suffix. The
 *   realpath'd ancestor is the security anchor: any symlink planted
 *   between it and `p` is invisible to us, but the prefix check in
 *   {@link assertPathInRoots} still uses the canonical ancestor's
 *   prefix — and the canonical ancestor IS inside-or-outside the
 *   root set, which is what we care about.
 *
 * Throws {@link KaosError} if the walk exhausts before hitting any
 * realpath-able anchor (e.g. a path whose root segment is missing).
 */
export async function resolveCanonicalPath(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch (firstErr) {
    let cursor = path.dirname(p);
    let suffix = path.basename(p);
    let lastErr: unknown = firstErr;
    while (true) {
      try {
        const realCursor = await fsp.realpath(cursor);
        return path.join(realCursor, suffix);
      } catch (e) {
        lastErr = e;
        const next = path.dirname(cursor);
        if (next === cursor) break;
        suffix = path.join(path.basename(cursor), suffix);
        cursor = next;
      }
    }
    throw new KaosError(
      `path-boundary: no canonical ancestor for ${p}: ${describeErr(lastErr)}`,
    );
  }
}

/**
 * Canonicalise every root up front. Missing roots fail-closed.
 *
 * Called once per session inside `maybeBuildAcpKaos`; passing the
 * result into {@link AcpKaos}'s constructor means every subsequent
 * `assertPathInRoots` call only handles the per-target resolve, not
 * the root resolve. That keeps the per-call hot path to a single
 * `realpath(target)` + O(N) prefix loop, instead of N `realpath`
 * per call.
 */
export async function resolveCanonicalRoots(
  roots: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(await fsp.realpath(r));
    } catch (err) {
      throw new KaosError(
        `path-boundary: cannot resolve root ${r}: ${describeErr(err)}`,
      );
    }
  }
  return out;
}

/**
 * Throw {@link KaosError} if `target`, after canonicalisation, is not
 * inside any of the canonical `roots`.
 *
 * Pass `roots` as the OUTPUT of {@link resolveCanonicalRoots} —
 * passing raw root paths would silently miss escapes if a root
 * itself is a symlink.
 *
 * The `operation` string is included in the error message so logs
 * can attribute the failure to a read vs write vs stat without
 * separate bookkeeping.
 */
export async function assertPathInRoots(
  target: string,
  roots: readonly string[],
  operation: string,
): Promise<void> {
  if (roots.length === 0) {
    // No roots allowed → fail closed. Spec: "If you cannot safely
    // determine whether the path is inside allowed roots, fail
    // closed." Equally, if the boundary literally is empty, every
    // path is outside.
    throw new KaosError(
      `path-boundary: ${operation} refused for ${target}: no workspace roots configured`,
    );
  }
  const realTarget = await resolveCanonicalPath(target);
  for (const root of roots) {
    if (realTarget === root) return;
    // Preserve trailing separator on root (e.g. '/' on POSIX) so the
    // prefix check works for the filesystem root itself, where
    // `root + path.sep` would expand to '//' and never match.
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (realTarget.startsWith(prefix)) return;
  }
  throw new KaosError(
    `path-boundary: ${operation} refused for ${target} — outside workspace roots`,
  );
}

function describeErr(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
    return `${code}: ${msg}`;
  }
  return err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
}
