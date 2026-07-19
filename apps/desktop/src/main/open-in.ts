// Desktop-native "open this workspace in <editor/terminal>". The app catalog
// is detected in the main process and launching goes through `open(1)` — each
// app's own Info.plist folder registration (verified against the installed
// bundles) turns `open -a <App> <dir>` into "a window at this directory".
// macOS only for now; other platforms return an empty catalog so the renderer
// hides the entry entirely (this is a desktop-only feature by design).
//
// Pure + dependency-injected (fs/spawn/platform/home) so tests need no Electron.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  | 'xcode';

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

export const OPEN_IN_APP_IDS: readonly OpenInAppId[] = APP_SPECS.map((spec) => spec.id);

export interface OpenInDetectDeps {
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (path: string) => boolean;
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
 * Returns [] off macOS — the renderer treats "empty catalog" as "hide".
 */
export function listAvailableOpenInApps(deps: OpenInDetectDeps = {}): OpenInAppInfo[] {
  const platform = deps.platform ?? process.platform;
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

/**
 * Opens `targetPath` in the given app. Never throws: every failure (unknown
 * app, unsupported platform, app not installed, `open` failing) comes back as
 * `{ ok: false, error }` so the IPC handler can forward it verbatim.
 */
export async function openInApp(
  appId: string,
  targetPath: string,
  deps: OpenInRunDeps = {},
): Promise<OpenInResult> {
  const spec = APP_SPECS.find((candidate) => candidate.id === appId);
  if (!spec) return { ok: false, error: `unknown open-in app: ${appId}` };
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return { ok: false, error: 'open-in is only supported on macOS' };
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
