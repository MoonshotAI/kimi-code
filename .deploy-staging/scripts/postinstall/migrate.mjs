/**
 * Detection of the previous Python `kimi-cli` shim and the actual
 * filesystem operations that perform (or refuse) the rename.
 *
 * Detection:
 *   - {@link detectLegacyShims}: walks the caller-supplied
 *     `pathString` and returns every legacy `kimi` shim along the
 *     way (in PATH order). A shim qualifies when it realpath-resolves
 *     outside our own installed package root and its head 4 KiB
 *     contains the `kimi_cli` module marker — the setuptools
 *     entry-point format produced by `uv tool install`,
 *     `pipx install`, `pip install`, etc. Returning all hits (not
 *     just the first) matters because a user with both uv- and
 *     pipx-installed `kimi-cli` has two legacy shims in different
 *     dirs, and renaming only the earlier one leaves the later one
 *     shadowing our new CLI. Callers should pass the `detection`
 *     field from `postinstallPaths()` so detection sees the union of
 *     the shell PATH and the installer's PATH.
 *   - {@link isLegacyShim}: same criterion in standalone form, used to
 *     decide whether an existing `kimi-legacy` is itself a legacy CLI
 *     (safe to consolidate over) or a user-managed file (preserve).
 *
 * Classify + execute (two-phase):
 *   - {@link classifyShim}: pre-flight inspection that says what we
 *     COULD do to a given shim. Returns one of `renameable`,
 *     `consolidate`, `delete-only`, `blocked`. No filesystem writes.
 *   - {@link renameInPlace} / {@link deleteShim}: the primitive
 *     operations that actually mutate the filesystem. Run after the
 *     orchestrator has looked at the full set of classifications and
 *     decided to proceed.
 *
 * Splitting classification from execution lets the orchestrator make
 * the abort-or-proceed decision once, against the whole detected set,
 * rather than discovering mid-loop that something failed and ending up
 * with a misleading "kimi now launches the new CLI" notice in front of
 * a "permission denied" notice. Uses `fs.lstat` (not `fs.access`) to
 * detect dangling symlinks at the target so we don't clobber them.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import { delimiter, dirname, extname, join, sep } from 'node:path';

const LEGACY_BIN = 'kimi';
const LEGACY_RENAME = 'kimi-legacy';
const PYTHON_MARKER = 'kimi_cli';
const IS_WINDOWS = process.platform === 'win32';

// Read window for the marker sniff.
//   POSIX: setuptools entry-point scripts are a few hundred bytes —
//          4 KiB is generous.
//   Windows: `uv tool install` produces a Rust-built launcher .exe
//            (~45 KiB) and the `kimi_cli` module name sits embedded
//            near the END of the file (verified offset ≈ 44103 on
//            uv 0.11). Cap reads at 256 KiB so a hostile or
//            unexpectedly large file can't make us hold a lot of
//            memory.
const SHIM_SNIFF_BYTES_POSIX = 4096;
const SHIM_SNIFF_BYTES_WINDOWS_MAX = 256 * 1024;

function pathEntries(pathString) {
  if (!pathString) return [];
  const seen = new Set();
  const out = [];
  for (const entry of pathString.split(delimiter)) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Expand `kimi` into the set of filenames that resolve as executables
 * on this platform. POSIX → just `['kimi']`. Windows → adds every
 * `PATHEXT` extension (so we find `kimi.exe`, `kimi.cmd`, etc).
 */
function executableCandidates(basename) {
  if (!IS_WINDOWS) return [basename];
  const pathext = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .toLowerCase()
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  return [basename, ...pathext.map((ext) => basename + ext)];
}

async function isExecutableFile(filePath) {
  try {
    const info = await fs.stat(filePath);
    if (!info.isFile()) return false;
    // Windows: stat().mode doesn't reflect ACLs in any useful way.
    // Callers already restrict to PATHEXT candidates, so existence
    // suffices.
    if (IS_WINDOWS) return true;
    return (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function readShimHead(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    const limit = IS_WINDOWS ? SHIM_SNIFF_BYTES_WINDOWS_MAX : SHIM_SNIFF_BYTES_POSIX;
    const target = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(target);
    const { bytesRead } = await handle.read(buffer, 0, target, 0);
    // `latin1` is a 1-to-1 byte→char mapping; we're searching for an
    // ASCII substring, so we don't want UTF-8 decoding to mangle the
    // bytes around the marker.
    return buffer.subarray(0, bytesRead).toString('latin1');
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Walk `pathString` and return every legacy `kimi` shim along the
 * way, in PATH order. The orchestrator renames each in turn — a
 * single rename is insufficient when the user has multiple legacy
 * installs (e.g. one from `uv tool install` and another from `pipx
 * install`) in different directories, because the survivor still
 * shadows the new CLI.
 *
 * Each entry has the same shape as the previous single-return
 * value: `{ shimPath, realPath }`. The empty array means
 * "fresh-install / no-op".
 */
export async function detectLegacyShims(ownRoot, pathString) {
  const ownRootPrefix = ownRoot ? ownRoot + sep : null;
  const candidates = executableCandidates(LEGACY_BIN);
  const results = [];
  const seenShims = new Set();

  for (const dir of pathEntries(pathString)) {
    for (const name of candidates) {
      const shimPath = join(dir, name);
      if (seenShims.has(shimPath)) continue;
      if (!(await isExecutableFile(shimPath))) continue;

      let realPath;
      try {
        realPath = await fs.realpath(shimPath);
      } catch {
        continue;
      }

      // Defence-in-depth: never touch a `kimi` that resolves into our
      // own installed package. The `kimi_cli` marker check below
      // already excludes the manager's generated wrapper today, but
      // this layer keeps us safe if anything in our bundle ever
      // happens to contain the marker substring.
      if (
        ownRootPrefix !== null &&
        (realPath === ownRoot || realPath.startsWith(ownRootPrefix))
      ) {
        continue;
      }

      const head = await readShimHead(realPath);
      if (!head || !head.includes(PYTHON_MARKER)) continue;

      seenShims.add(shimPath);
      results.push({ shimPath, realPath });
    }
  }
  return results;
}

/**
 * Does the file at `p` look like the legacy Python `kimi-cli`?
 *
 * Same criterion as {@link detectLegacyShim} uses to recognize the
 * original shim: realpath-resolvable and the first 4 KiB of the
 * resolved file contains the `kimi_cli` module name. Used to decide
 * whether an existing `kimi-legacy` is itself a legacy shim (safe to
 * drop the duplicate `kimi`) or a user-managed file we must not
 * clobber.
 */
export async function isLegacyShim(p) {
  let real;
  try {
    real = await fs.realpath(p);
  } catch {
    return false;
  }
  const head = await readShimHead(real);
  return Boolean(head && head.includes(PYTHON_MARKER));
}

async function pathExists(p) {
  try {
    // lstat (not access/stat) so a dangling symlink at `p` still
    // reports as existing — `fs.access` follows symlinks and would
    // return ENOENT for a broken link, after which `fs.rename` would
    // silently replace it.
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute where `shimPath` should be renamed to. Preserves the file
 * extension so a Windows `C:\…\kimi.exe` ends up at `kimi-legacy.exe`
 * rather than an extension-less `kimi-legacy` that `kimi.exe -- legacy`
 * shells won't run.
 */
function renameTargetFor(shimPath) {
  const ext = extname(shimPath);  // "" on POSIX, ".exe" on Windows
  return join(dirname(shimPath), LEGACY_RENAME + ext);
}

/**
 * Is the directory containing `shimPath` a system-managed location
 * the current user can't write to?
 *
 * POSIX: dir owned by uid 0 (root) — captures
 *   `sudo pip install kimi-cli` → `/usr/local/bin/`.
 *
 * Windows: dir under one of the well-known system roots
 *   (`C:\Program Files`, `C:\ProgramData`, `C:\Windows`). uv tool
 *   installs land in user space (`%USERPROFILE%\.local\bin`) so this
 *   path almost never fires on Windows in practice, but the heuristic
 *   correctly classifies the rare admin-prefix install case.
 *
 * The dedicated permission-denied notice (`logPermissionDenied`)
 * uses this to switch from a bare "rename it manually" message to a
 * sudo-aware / admin-aware explanation.
 */
async function isSystemOwnedDir(shimPath) {
  if (IS_WINDOWS) {
    const dir = dirname(shimPath).toLowerCase();
    const systemRoots = [
      'c:\\program files',
      'c:\\program files (x86)',
      'c:\\programdata',
      'c:\\windows',
    ];
    return systemRoots.some(
      (root) => dir === root || dir.startsWith(root + '\\'),
    );
  }
  try {
    const info = await fs.stat(dirname(shimPath));
    return info.uid === 0;
  } catch {
    return false;
  }
}

async function canWriteDir(dir) {
  try {
    // For `fs.rename` and `fs.unlink` the parent dir needs to be both
    // writable and executable (POSIX `wx`). `fs.access` follows the
    // same semantics. On Windows ACL details are coarse but
    // `fs.access(W_OK)` is a reasonable best-effort.
    await fs.access(dir, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-flight inspection of a single legacy shim. Returns what action
 * we could take WITHOUT executing it. The orchestrator uses these
 * classifications to decide the whole-set strategy (abort vs proceed,
 * which shim becomes kimi-legacy) before any filesystem writes
 * happen.
 *
 * Result shapes (all carry `shimPath` and `target` so the renderer
 * has the paths):
 *   - `renameable`     : can `fs.rename(shim → target)` cleanly;
 *                        target slot is free.
 *   - `consolidate`    : target already exists and is itself a legacy
 *                        shim; we'd `fs.unlink(shim)` and leave the
 *                        existing `kimi-legacy` as the canonical
 *                        fallback (functionally equivalent — same
 *                        upstream package).
 *   - `delete-only`    : target exists but is a user-managed file we
 *                        won't clobber. We can still `fs.unlink(shim)`
 *                        to stop the shadowing; the
 *                        "preserve original kimi" invariant fails for
 *                        THIS dir (we tell the user).
 *   - `blocked`        : we can't write to the parent dir. Carries
 *                        `isSystemPath` so the renderer can suggest
 *                        sudo (POSIX) or admin PowerShell (Windows).
 */
export async function classifyShim(shimPath) {
  const target = renameTargetFor(shimPath);
  const dir = dirname(shimPath);

  if (!(await canWriteDir(dir))) {
    return {
      kind: 'blocked',
      shimPath,
      target,
      isSystemPath: await isSystemOwnedDir(shimPath),
    };
  }

  if (await pathExists(target)) {
    if (await isLegacyShim(target)) {
      return { kind: 'consolidate', shimPath, target };
    }
    return { kind: 'delete-only', shimPath, target };
  }

  return { kind: 'renameable', shimPath, target };
}

/**
 * Execute an `fs.rename`. Pre-flight classification establishes
 * whether this is expected to succeed; this primitive just runs the
 * call and wraps the error.
 */
export async function renameInPlace(shimPath, target) {
  try {
    await fs.rename(shimPath, target);
    return { success: true };
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, code, message };
  }
}

/**
 * Execute an `fs.unlink`. Used when:
 *   - we're consolidating onto an existing legacy `kimi-legacy`, or
 *   - we couldn't rename (foreign target) but can still remove the
 *     shadow, or
 *   - this is a non-first shim and we just want to clear it out so
 *     PATH order resolves to our new CLI.
 */
export async function deleteShim(shimPath) {
  try {
    await fs.unlink(shimPath);
    return { success: true };
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, code, message };
  }
}
