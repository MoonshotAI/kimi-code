// Desktop-native "open this workspace in <editor/terminal>". On macOS the app
// catalog is detected from /Applications bundles and launching goes through
// `open(1)`; on Windows it's detected from the well-known per-user / system
// install locations and launched detached. Other platforms return an empty
// catalog so the renderer hides the entry entirely (this is a desktop-only
// feature by design).
//
// Pure + dependency-injected (fs/spawn/platform/home/env) so tests need no Electron.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type OpenInAppId =
  | 'vscode'
  | 'vscode-insiders'
  | 'cursor'
  | 'zed'
  | 'finder'
  | 'terminal'
  | 'iterm'
  | 'ghostty'
  | 'warp'
  | 'kitty'
  | 'xcode'
  | 'explorer'
  | 'windows-terminal'
  | 'git-bash';

export interface OpenInAppInfo {
  id: OpenInAppId;
  label: string;
}

interface OpenInAppSpec {
  id: OpenInAppId;
  label: string;
  /** "<Name>.app" bundle, looked up under /Applications and ~/Applications. */
  bundleName?: string;
  /** LaunchServices bundle id for `open -b` (system apps whose path moves). */
  bundleId?: string;
}

// Menu order: editors first, then the file manager, then terminals; Xcode last.
const APP_SPECS: readonly OpenInAppSpec[] = [
  { id: 'vscode', label: 'VS Code', bundleName: 'Visual Studio Code.app' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', bundleName: 'Visual Studio Code - Insiders.app' },
  { id: 'cursor', label: 'Cursor', bundleName: 'Cursor.app' },
  { id: 'zed', label: 'Zed', bundleName: 'Zed.app' },
  { id: 'finder', label: 'Finder' },
  { id: 'terminal', label: 'Terminal', bundleId: 'com.apple.Terminal' },
  { id: 'iterm', label: 'iTerm2', bundleName: 'iTerm.app' },
  { id: 'ghostty', label: 'Ghostty', bundleName: 'Ghostty.app' },
  { id: 'warp', label: 'Warp', bundleName: 'Warp.app' },
  { id: 'kitty', label: 'kitty', bundleName: 'kitty.app' },
  // No folder registration in its Info.plist: Xcode decides per path (Swift
  // package folders open, plain folders may just alert). Kept to match the
  // familiar "editors I have" list.
  { id: 'xcode', label: 'Xcode', bundleName: 'Xcode.app' },
];

/**
 * Default existence probe. `existsSync` follows reparse points, and stat'ing a
 * Windows app-execution alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`)
 * fails EACCES — the alias would look "not installed" even though CreateProcess
 * launches it fine. lstat reads the reparse point itself, so it is the fallback.
 */
function defaultExists(path: string): boolean {
  if (existsSync(path)) return true;
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface OpenInDetectDeps {
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (path: string) => boolean;
  /** Environment for install-location lookups (LOCALAPPDATA / ProgramFiles). */
  env?: NodeJS.ProcessEnv;
}

/** Resolves the on-disk path of a ".app" bundle, or null when not installed. */
function resolveBundlePath(
  spec: OpenInAppSpec,
  exists: (path: string) => boolean,
  home: string,
): string | null {
  if (spec.bundleName === undefined) return null;
  for (const dir of ['/Applications', join(home, 'Applications')]) {
    const candidate = join(dir, spec.bundleName);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Apps that are part of macOS / always launchable without a bundle lookup. */
function isSystemProvided(spec: OpenInAppSpec): boolean {
  return spec.id === 'finder' || spec.bundleId !== undefined;
}

/**
 * Apps currently installed (or system-provided) that can open a directory.
 * Returns [] off macOS/Windows — the renderer treats "empty catalog" as "hide".
 */
export function listAvailableOpenInApps(deps: OpenInDetectDeps = {}): OpenInAppInfo[] {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const env = deps.env ?? process.env;
    const exists = deps.exists ?? defaultExists;
    return WINDOWS_APP_SPECS.filter((spec) => spec.resolve(env, exists) !== null).map((spec) => ({
      id: spec.id,
      label: spec.label,
    }));
  }
  if (platform !== 'darwin') return [];
  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();
  const available: OpenInAppInfo[] = [];
  for (const spec of APP_SPECS) {
    if (isSystemProvided(spec) || resolveBundlePath(spec, exists, home) !== null) {
      available.push({ id: spec.id, label: spec.label });
    }
  }
  return available;
}

// --- Windows --------------------------------------------------------------------
//
// Editors install per-user by default (LOCALAPPDATA\Programs); the system-wide
// Program Files variants are covered too. File Explorer and a terminal are
// always present (Windows Terminal when its `wt.exe` alias is detectable,
// otherwise Windows PowerShell); Git Bash appears when Git for Windows is
// installed. Everything launches detached — a GUI app outlives this process,
// and explorer.exe in particular exits non-zero even on a successful open, so
// the exit code is meaningless.

interface WindowsAppSpec {
  id: OpenInAppId;
  label: string;
  /** Launch command: an absolute exe path, or a name spawn resolves through
      PATH. null = not installed. */
  resolve(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | null;
  args(dir: string, command: string): string[];
  /** Alternative launcher for console-subsystem commands (the PowerShell
      fallback). Spawning such an exe directly either gets it DETACHED_PROCESS
      (no console at all — the click looks like a no-op) or kills it on stdin
      EOF. Returning non-null routes the launch through `cmd /c start`, which
      gives the app a real interactive console window. */
  consoleLaunch?(
    dir: string,
    command: string,
  ): { command: string; args: string[]; env?: NodeJS.ProcessEnv } | null;
}

/** Env var carrying the workspace path to the `cmd /c start` launcher. cmd
    expands %-variables in its command line, so a workspace path containing a
    literal `%NAME%` segment would be mangled if passed inline; expansion is
    single-pass, so a value arriving through the environment survives intact. */
const OPEN_IN_DIR_ENV = 'KIMI_CODE_OPEN_IN_DIR';

function firstExisting(paths: string[], exists: (path: string) => boolean): string | null {
  for (const candidate of paths) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Per-user + system-wide install candidates for one editor directory name. */
function editorExeCandidates(env: NodeJS.ProcessEnv, ...suffixes: string[]): string[] {
  const roots = [
    env['LOCALAPPDATA'] === undefined ? undefined : join(env['LOCALAPPDATA'], 'Programs'),
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
  ].filter((root): root is string => root !== undefined);
  const candidates: string[] = [];
  for (const suffix of suffixes) {
    for (const root of roots) {
      candidates.push(join(root, suffix));
    }
  }
  return candidates;
}

function pathExeCandidates(env: NodeJS.ProcessEnv, executable: string): string[] {
  const path = env['Path'] ?? env['PATH'] ?? '';
  return path
    .split(';')
    .filter((entry) => entry !== '')
    .map((entry) => join(entry, executable));
}

function terminalCommand(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  const candidates = [
    ...(env['LOCALAPPDATA'] === undefined
      ? []
      : [join(env['LOCALAPPDATA'], 'Microsoft', 'WindowsApps', 'wt.exe')]),
    ...pathExeCandidates(env, 'wt.exe'),
  ];
  const wt = firstExisting(candidates, exists);
  if (wt !== null) return wt;
  // Fallback: the inbox Windows PowerShell, by absolute path. The launch goes
  // through `start /D <workspace>`, which makes the workspace the new process's
  // current directory — an unqualified `powershell.exe` would resolve against a
  // same-named file in the workspace before PATH.
  return join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Menu order: editors first, then the file manager, then terminals.
const WINDOWS_APP_SPECS: readonly WindowsAppSpec[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    resolve: (env, exists) =>
      firstExisting(editorExeCandidates(env, join('Microsoft VS Code', 'Code.exe')), exists),
    args: (dir) => [dir],
  },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    resolve: (env, exists) =>
      firstExisting(
        editorExeCandidates(env, join('Microsoft VS Code Insiders', 'Code - Insiders.exe')),
        exists,
      ),
    args: (dir) => [dir],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    resolve: (env, exists) =>
      firstExisting(
        editorExeCandidates(env, join('cursor', 'Cursor.exe'), join('Cursor', 'Cursor.exe')),
        exists,
      ),
    args: (dir) => [dir],
  },
  {
    id: 'zed',
    label: 'Zed',
    resolve: (env, exists) => firstExisting(editorExeCandidates(env, join('Zed', 'Zed.exe')), exists),
    args: (dir) => [dir],
  },
  {
    id: 'explorer',
    label: 'File Explorer',
    resolve: () => 'explorer.exe',
    args: (dir) => [dir],
  },
  {
    id: 'windows-terminal',
    label: 'Terminal',
    resolve: terminalCommand,
    args: (dir) => ['-d', dir],
    // PowerShell fallback (no Windows Terminal): `cmd /c start` opens it in a
    // real console window. cmd exits immediately — the window is PowerShell's.
    // The working directory rides in an env var (see OPEN_IN_DIR_ENV) because
    // cmd would expand a literal `%NAME%` in an inline path; /D applies it, so
    // the path never goes through shell parsing.
    consoleLaunch: (dir, command) =>
      command.toLowerCase().endsWith('wt.exe')
        ? null
        : {
            command: 'cmd.exe',
            args: ['/c', 'start', '"PowerShell"', '/D', `"%${OPEN_IN_DIR_ENV}%"`, command],
            env: { [OPEN_IN_DIR_ENV]: dir },
          },
  },
  {
    id: 'git-bash',
    label: 'Git Bash',
    resolve: (env, exists) =>
      firstExisting(editorExeCandidates(env, join('Git', 'git-bash.exe')), exists),
    args: (dir) => [`--cd=${dir}`],
  },
];

export const OPEN_IN_APP_IDS: readonly OpenInAppId[] = [
  ...new Set([...APP_SPECS, ...WINDOWS_APP_SPECS].map((spec) => spec.id)),
];

/** Builds the `open(1)` argv for a spec, or null when it cannot launch here. */
function buildOpenArgs(
  spec: OpenInAppSpec,
  targetPath: string,
  exists: (path: string) => boolean,
  home: string,
): string[] | null {
  // Bare `open <dir>` hands the directory to its default handler — Finder.
  if (spec.id === 'finder') return [targetPath];
  if (spec.bundleId !== undefined) return ['-b', spec.bundleId, targetPath];
  const appPath = resolveBundlePath(spec, exists, home);
  if (appPath === null) return null;
  return ['-a', appPath, targetPath];
}

export interface OpenInRunDeps extends OpenInDetectDeps {
  /** Command runner, injected by tests. Defaults to spawning the real binary. */
  run?: (command: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;
  /** Detached GUI launcher (Windows), injected by tests. */
  runDetached?: (
    command: string,
    args: string[],
    options?: { consoleWindow?: boolean; env?: NodeJS.ProcessEnv },
  ) => Promise<{ error: string | null }>;
}

function defaultRun(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr: stderr.trim() }));
  });
}

export type OpenInResult = { ok: true } | { ok: false; error: string };

/** Windows launch: detached spawn, resolved on the 'spawn' event — GUI apps
    outlive the caller, and explorer.exe exits non-zero even on a successful
    open, so the exit code is never consulted. The consoleWindow variant (the
    `cmd /c start` console launcher) must NOT be detached: cmd needs a console
    for `start` to give the target its own window. Args pass verbatim — cmd's
    quote parsing is not MSVCRT argv parsing, and the launcher args carry their
    own quotes already. */
function runDetached(
  command: string,
  args: string[],
  options: { consoleWindow?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ error: string | null }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child =
        options.consoleWindow === true
          ? spawn(command, args, {
              stdio: 'ignore',
              windowsHide: false,
              windowsVerbatimArguments: true,
              env: { ...process.env, ...options.env },
            })
          : spawn(command, args, { detached: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.once('error', (error: Error) => resolve({ error: error.message }));
    child.once('spawn', () => {
      child.unref();
      resolve({ error: null });
    });
  });
}

async function openInAppWindows(
  appId: string,
  targetPath: string,
  deps: OpenInRunDeps,
): Promise<OpenInResult> {
  const spec = WINDOWS_APP_SPECS.find((candidate) => candidate.id === appId);
  if (spec === undefined) return { ok: false, error: `unknown open-in app: ${appId}` };
  const command = spec.resolve(deps.env ?? process.env, deps.exists ?? defaultExists);
  if (command === null) return { ok: false, error: `${spec.label} is not installed` };
  const consoleLaunch = spec.consoleLaunch?.(targetPath, command) ?? null;
  const launch = consoleLaunch ?? { command, args: spec.args(targetPath, command) };
  const run = deps.runDetached ?? runDetached;
  const { error } = await run(launch.command, launch.args, {
    consoleWindow: consoleLaunch !== null,
    env: consoleLaunch?.env,
  });
  return error === null ? { ok: true } : { ok: false, error };
}

/**
 * Opens `targetPath` in the given app. Never throws: every failure (unknown
 * app, unsupported platform, app not installed, spawn failing) comes back as
 * `{ ok: false, error }` so the IPC handler can forward it verbatim.
 */
export async function openInApp(
  appId: string,
  targetPath: string,
  deps: OpenInRunDeps = {},
): Promise<OpenInResult> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return openInAppWindows(appId, targetPath, deps);
  const spec = APP_SPECS.find((candidate) => candidate.id === appId);
  if (!spec) return { ok: false, error: `unknown open-in app: ${appId}` };
  if (platform !== 'darwin') return { ok: false, error: 'open-in is only supported on macOS and Windows' };
  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();
  const args = buildOpenArgs(spec, targetPath, exists, home);
  if (args === null) return { ok: false, error: `${spec.label} is not installed` };
  const run = deps.run ?? defaultRun;
  try {
    const { code, stderr } = await run('open', args);
    if (code !== 0) return { ok: false, error: stderr !== '' ? stderr : `open exited with code ${code}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
