/**
 * Where the user actually types things, and what `kimi` resolves to
 * from there.
 *
 * Covers:
 *
 *   - Package-manager detection ({@link detectPackageManager}) and
 *     manager-specific command hints ({@link pmGlobalBinCommand},
 *     {@link pmGlobalInstallCommand}) used in user-facing notices.
 *   - Global-install gating ({@link isGlobalInstall}) — what counts as
 *     a global install across npm / yarn classic / pnpm.
 *   - Own-package-root location ({@link ownPackageRoot}) — walks up
 *     from `import.meta.dirname` looking for `package.json`.
 *   - User-shell PATH ({@link userShellPath}) — spawns `$SHELL -l` so
 *     we can check reachability from the shell the user will type
 *     `kimi` into, not just the installer's environment.
 *   - The combined PATH dispatcher ({@link postinstallPaths}) —
 *     called once by the orchestrator so detection and reachability
 *     stay symmetric and the shell probe doesn't run twice.
 *   - The reachability check ({@link findFirstResolvableKimi}) —
 *     walks PATH treating the to-be-renamed legacy shims as gone
 *     and reports what wins resolution. Distinguishes our own shim
 *     from a blocked legacy that's still in the way vs. an
 *     unknown/foreign `kimi` (e.g. a user-written wrapper).
 *
 * All functions are pure w.r.t. the filesystem (no mutations).
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { delimiter, dirname, join, sep } from 'node:path';

const LEGACY_BIN = 'kimi';
const IS_WINDOWS = process.platform === 'win32';

/**
 * Expand a basename like `kimi` into the set of filenames the OS
 * would actually match on PATH.
 *
 * On POSIX: just `['kimi']`.
 *
 * On Windows: `['kimi', 'kimi.exe', 'kimi.cmd', …]` — every
 * extension in `PATHEXT`. Without this, our PATH walk would miss
 * the typical `kimi.exe` shim produced by `uv tool install` on
 * Windows.
 */
export function executableCandidates(basename) {
  if (!IS_WINDOWS) return [basename];
  const pathext = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .toLowerCase()
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  return [basename, ...pathext.map((ext) => basename + ext)];
}

/**
 * Identify which package manager ran us. `npm_config_user_agent` is
 * set by npm, yarn (classic + berry), and pnpm, and starts with the
 * manager's name plus version. Defaults to `'npm'` for unknown /
 * missing values.
 */
export function detectPackageManager() {
  const ua = process.env['npm_config_user_agent'] ?? '';
  if (ua.startsWith('pnpm/')) return 'pnpm';
  if (ua.startsWith('yarn/')) return 'yarn';
  return 'npm';
}

/**
 * Manager-specific shell command that prints (or expands to) the
 * global bin directory. Used in the PATH-fix hint so the suggestion
 * is valid regardless of which manager the user ran.
 */
export function pmGlobalBinCommand(pm) {
  switch (pm) {
    case 'pnpm':
      return 'pnpm bin -g';
    case 'yarn':
      return 'yarn global bin';
    case 'npm':
    default:
      return 'npm prefix -g';
  }
}

/** Manager-specific reinstall command, used in the success-notice hint. */
export function pmGlobalInstallCommand(pm, pkg) {
  switch (pm) {
    case 'pnpm':
      return `pnpm add -g ${pkg}`;
    case 'yarn':
      return `yarn global add ${pkg}`;
    case 'npm':
    default:
      return `npm install -g ${pkg}`;
  }
}

/**
 * Did the user run a global install via some Node package manager?
 *
 * We accept four signals, any of which means "this install is
 * landing in the manager's global bin directory":
 *
 *   - `npm_config_global === 'true'`  — set by `npm install -g`, and
 *     by pnpm on its global paths for back-compat.
 *   - `pnpm_config_global === 'true'` — set by pnpm in addition to
 *     the npm-compat flag above.
 *   - `npm_config_location === 'global'` — set by npm 7+ when the
 *     user passes `--location=global` (or runs `npm config set
 *     location global` persistently). npm intentionally does NOT
 *     also set `npm_config_global` in this case, so without this
 *     branch the migration silently no-ops for `npm install
 *     --location=global @moonshot-ai/kimi-code` — verified on npm
 *     11.13.0.
 *   - {@link isYarnClassicGlobalAdd} — yarn classic does NOT set
 *     `npm_config_global` for `yarn global add`. The only reliable
 *     signal is parsing `npm_config_argv` and seeing the `global`
 *     subcommand. Verified on yarn 1.22.22.
 *
 * Local installs, `npx`, `pnpm dlx`, and workspace bootstraps leave
 * all four signals false.
 *
 * Yarn berry (v2+) intentionally has no global-install concept, so
 * it doesn't matter here. Postinstall on yarn berry runs in local
 * context.
 */
export function isGlobalInstall() {
  return (
    process.env['npm_config_global'] === 'true' ||
    process.env['pnpm_config_global'] === 'true' ||
    process.env['npm_config_location'] === 'global' ||
    isYarnClassicGlobalAdd()
  );
}

/**
 * `yarn global add` (yarn classic, v1.x) runs lifecycle scripts but
 * leaves both `npm_config_global` and `npm_config_location` unset.
 * The only reliable in-band signal is `npm_config_argv`, which yarn
 * populates with the original command line as JSON:
 *   { original: ["global", "add", "<pkg>", "--prefix=..."] }
 * Parse it and require both:
 *   - `npm_config_user_agent` starts with `yarn/1.` (yarn classic;
 *     yarn berry has no global concept anyway).
 *   - Some token in argv is literally `"global"` AND the very next
 *     token is a known yarn-global subcommand (`add`, `remove`,
 *     etc). This handles the simple case (`yarn global add foo` →
 *     argv `["global","add",...]`) and the value-taking-flag case
 *     (`yarn --cwd /tmp global add foo` → argv `["--cwd","/tmp",
 *     "global","add",...]`) without having to maintain yarn's full
 *     flag table. It rejects `yarn add global` (the next token is
 *     undefined) and `yarn add @scope/global` (the literal string
 *     `"global"` doesn't appear). The remaining false positives
 *     (e.g., `yarn add global add` — installing two packages, one
 *     literally named `global`) are caught downstream by the
 *     reachability gate: a local install's bin dir isn't on PATH,
 *     so `isOwnCliResolvableFirst` will refuse to migrate.
 */
function isYarnClassicGlobalAdd() {
  const ua = process.env['npm_config_user_agent'] ?? '';
  if (!ua.startsWith('yarn/1.')) return false;
  const raw = process.env['npm_config_argv'];
  if (!raw) return false;
  let argv;
  try {
    argv = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(argv?.original)) return false;
  const globalIdx = argv.original.indexOf('global');
  if (globalIdx === -1) return false;
  const next = argv.original[globalIdx + 1];
  return typeof next === 'string' && YARN_GLOBAL_SUBCOMMANDS.has(next);
}

// Yarn 1.x global subcommands. The install-class ones (`add`,
// `upgrade`, `upgrade-interactive`) are the ones that actually run
// our postinstall, but the read-only ones are included so the
// detection is consistent across all `yarn global ...` invocations.
const YARN_GLOBAL_SUBCOMMANDS = new Set([
  'add',
  'remove',
  'upgrade',
  'upgrade-interactive',
  'list',
  'bin',
  'dir',
]);

/**
 * Locate the realpath of our own installed package root.
 *
 * Callers pass the starting directory (typically `import.meta.dirname`
 * of the entry script, which lives at `<package-root>/scripts/`). We
 * walk up looking for the nearest `package.json`, then `realpath` the
 * directory so symlinked install layouts (e.g. `<prefix>/bin/kimi`
 * symlinked into `lib/node_modules/.../dist/main.mjs`) compare equal
 * in the caller's prefix check.
 *
 * Returns null if no `package.json` is found within a few levels —
 * callers should treat that as "can't locate ourselves" and bail.
 */
export async function ownPackageRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    try {
      await fs.access(join(dir, 'package.json'));
      try {
        return await fs.realpath(dir);
      } catch {
        return dir;
      }
    } catch {
      // No `package.json` here; walk up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function isExecutableFile(filePath) {
  try {
    const info = await fs.stat(filePath);
    if (!info.isFile()) return false;
    // Windows: ACLs aren't visible through stat().mode meaningfully —
    // existence + a recognized extension is what PATHEXT-style lookup
    // checks. Callers only pass us candidates that already match an
    // extension in `executableCandidates()`, so "is a file" suffices.
    if (IS_WINDOWS) return true;
    return (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// Package-manager shim generators embed the package's resolved path
// into the wrapper file. So any shim whose first KB contains our
// package name is one we own. Used as a fallback when realpath alone
// can't catch the shim — that happens for:
//   - Windows cmd-shims (literal `.cmd` / `.ps1` files, not symlinks)
//   - pnpm POSIX shims (literal `/bin/sh` scripts, not symlinks; pnpm
//     does not symlink into the package root the way npm/yarn classic
//     do on POSIX)
const PACKAGE_NAME_MARKERS = ['@moonshot-ai/kimi-code', '@moonshot-ai\\kimi-code'];

async function shimReferencesOwnPackage(shimPath) {
  try {
    const handle = await fs.open(shimPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, 4096, 0);
      const text = buf.subarray(0, bytesRead).toString('latin1');
      return PACKAGE_NAME_MARKERS.some((m) => text.includes(m));
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

async function classifyShim(shim, ownRoot, ownPrefix) {
  let real;
  try {
    real = await fs.realpath(shim);
  } catch {
    return 'unreadable';
  }
  if (real === ownRoot || real.startsWith(ownPrefix)) return 'own';
  if (await shimReferencesOwnPackage(shim)) return 'own';
  return 'other';
}

/**
 * Walk `pathString` and report what the user's shell would resolve
 * `kimi` to, AFTER the to-be-removed shims in `actionableShimPaths`
 * are pretended gone. Returns the first match by PATH order:
 *
 *   - { kind: 'own' }                     — our shim wins.
 *   - { kind: 'blocked-legacy', shim }    — a legacy `kimi` we
 *     detected but couldn't touch (a "blocked" shim) wins.
 *   - { kind: 'foreign', path }           — something else wins: a
 *     `kimi` we didn't recognize as a legacy CLI and didn't generate
 *     ourselves (e.g. a user-managed wrapper script in `~/bin`).
 *   - { kind: 'none' }                    — no `kimi` resolves at all.
 *
 * Used by the orchestrator to give an accurate "why the takeover
 * can't proceed" notice: a blocked-legacy blocker needs different
 * remediation (sudo / admin delete) than a foreign blocker (the
 * user's own file, which only they can decide what to do with).
 *
 * `allDetectedShimPaths` is every legacy shim our detector found
 * (both blocked and actionable). It lets us distinguish a blocked
 * legacy that survived our hypothetical removal pass from a totally
 * unknown `kimi`.
 */
export async function findFirstResolvableKimi(
  ownRoot,
  pathString,
  actionableShimPaths,
  allDetectedShimPaths,
) {
  if (!ownRoot || !pathString) return { kind: 'none' };
  const ownPrefix = ownRoot + sep;
  const candidates = executableCandidates(LEGACY_BIN);
  const skipSet = new Set(actionableShimPaths ?? []);
  const knownLegacySet = new Set(allDetectedShimPaths ?? []);
  const seenDirs = new Set();
  for (const dir of pathString.split(delimiter)) {
    if (!dir || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (const name of candidates) {
      const shim = join(dir, name);
      if (skipSet.has(shim)) continue;
      if (!(await isExecutableFile(shim))) continue;
      const kind = await classifyShim(shim, ownRoot, ownPrefix);
      if (kind === 'unreadable') continue;
      if (kind === 'own') return { kind: 'own' };
      if (knownLegacySet.has(shim)) {
        return { kind: 'blocked-legacy', shim };
      }
      return { kind: 'foreign', path: shim };
    }
  }
  return { kind: 'none' };
}

/**
 * Read the user's default shell's view of `PATH`.
 *
 * Why: `process.env.PATH` reflects the environment of whichever
 * shell the user happened to invoke the package manager from, which
 * may or may not match the daily-driver shell they'll later type
 * `kimi` into. A `~/.zshrc`-only PATH entry, a `~/.bash_profile`
 * that doesn't source `~/.bashrc`, or a sudo'd install that scrubs
 * HOME all break the installer's-PATH heuristic.
 *
 * We spawn `$SHELL -l -c 'printf %s "$PATH"'` so the shell reads
 * its login-profile files (`.profile`, `.bash_profile`, `.zprofile`).
 * `-i` would also pull in interactive rc files (`.bashrc`, `.zshrc`)
 * but it requires a tty for some shells and is much more likely to
 * have side effects (prompts, agent startup) — we accept the
 * narrower view and let `'unknown'` fall through to a gentler
 * check.
 *
 * Outcomes:
 *   { kind: 'ok',      path: string }   — shell printed its PATH.
 *   { kind: 'unknown', reason: string } — `$SHELL` missing, spawn
 *                                         failed, timed out, or
 *                                         shell printed no `PATH`.
 */
export async function userShellPath() {
  // Windows has no `$SHELL`/login-shell concept worth probing — cmd.exe
  // and PowerShell don't have profile files in the rc-chain sense, and
  // their PATH already comes from the user's persistent registry env
  // (which is what `process.env.PATH` reflects). Skip the spawn and
  // let the caller fall back to `process.env.PATH`.
  if (IS_WINDOWS) return { kind: 'unknown', reason: 'windows skip' };

  const shell = process.env['SHELL'];
  if (!shell) return { kind: 'unknown', reason: 'no SHELL env var' };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let stdout = '';
    // Wrap PATH in delimiters we can parse out, defensively, in case
    // the shell prints anything else (motd, prompt redraw, …).
    const probe =
      'printf "<<<KIMI_PATH_BEGIN>>>%s<<<KIMI_PATH_END>>>\\n" "$PATH"';
    const child = spawn(shell, ['-l', '-c', probe], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });

    // Bound the wait. Login rc files are usually quick, but a hostile
    // `.profile` could hang indefinitely.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ kind: 'unknown', reason: 'shell spawn timed out' });
    }, 5000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const match = stdout.match(
        /<<<KIMI_PATH_BEGIN>>>([\s\S]*?)<<<KIMI_PATH_END>>>/,
      );
      if (match && match[1].length > 0) {
        settle({ kind: 'ok', path: match[1] });
        return;
      }
      settle({ kind: 'unknown', reason: `no PATH printed (exit ${code})` });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      settle({ kind: 'unknown', reason: `spawn error: ${err.message}` });
    });
  });
}

/**
 * Compute the two PATH strings the postinstall consults.
 *
 *   - `detection`: a `delimiter`-joined union of the user's shell
 *     PATH and `process.env.PATH`, deduplicated. Used by
 *     {@link detectLegacyShim} to walk for legacy shims. We union
 *     because either source may contain a legacy `kimi` we want to
 *     rename — including one that lives in a directory the
 *     installer's environment can't see but the user's shell can
 *     (e.g. a sanitized lifecycle env from a packaged manager), and
 *     vice versa.
 *
 *   - `reachability`: the user's shell PATH if we can probe it, else
 *     `process.env.PATH`. Used to verify our own shim is on the PATH
 *     the user will actually type `kimi` into. We do NOT union here:
 *     a shim that's only in the installer's PATH wouldn't help the
 *     user after the install, so unioning would mis-classify the
 *     install as reachable.
 *
 * Returns a single object so the (potentially slow) shell-probe runs
 * just once per postinstall.
 */
export async function postinstallPaths() {
  const shellResult = await userShellPath();
  const processPath = process.env['PATH'] ?? '';
  const shellPathStr = shellResult.kind === 'ok' ? shellResult.path : null;
  const reachability = shellPathStr ?? processPath;
  const detection = unionPaths(shellPathStr, processPath);
  return { detection, reachability };
}

function unionPaths(...paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    for (const entry of p.split(delimiter)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.join(delimiter);
}

