
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, win32 } from 'node:path';

import { isOfficeDocumentPath } from '@moonshot-ai/app-core/preview';

import { queryRegValue, type RegQuery } from './win-registry';

export type OpenInAppId =
  | 'typora'
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
  | 'file-manager'
  | 'windows-terminal'
  | 'git-bash'
  | 'safari'
  | 'chrome'
  | 'arc'
  | 'edge'
  | 'firefox'
  | 'brave'
  | 'preview';

export interface OpenInAppInfo {
  id: OpenInAppId;
  label: string;
  preferred?: boolean;
}

interface OpenInAppSpec {
  id: OpenInAppId;
  label: string;
  bundleName?: string;
  bundleId?: string;
}

const TYPORA_SPEC: OpenInAppSpec = { id: 'typora', label: 'Typora', bundleName: 'Typora.app' };

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
  { id: 'xcode', label: 'Xcode', bundleName: 'Xcode.app' },
];

const BROWSER_SPECS: readonly OpenInAppSpec[] = [
  { id: 'chrome', label: 'Chrome', bundleName: 'Google Chrome.app' },
  { id: 'safari', label: 'Safari', bundleName: 'Safari.app' },
  { id: 'arc', label: 'Arc', bundleName: 'Arc.app' },
  { id: 'edge', label: 'Edge', bundleName: 'Microsoft Edge.app' },
  { id: 'firefox', label: 'Firefox', bundleName: 'Firefox.app' },
  { id: 'brave', label: 'Brave', bundleName: 'Brave Browser.app' },
];

const PREVIEW_SPEC: OpenInAppSpec = { id: 'preview', label: 'Preview', bundleName: 'Preview.app' };

const BROWSER_FILE_EXTS: ReadonlySet<string> = new Set(['.html', '.htm', '.svg']);
const PREVIEW_FILE_EXTS: ReadonlySet<string> = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.jfif',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.ico',
  '.heic',
  '.avif',
]);
const WIN_IMAGE_FILE_EXTS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.jfif',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
]);
const WIN_BROWSER_FILE_EXTS: ReadonlySet<string> = new Set([
  ...BROWSER_FILE_EXTS,
  '.pdf',
  ...WIN_IMAGE_FILE_EXTS,
]);

const MARKDOWN_FILE_EXTS: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdx']);
const EDITOR_IDS: ReadonlySet<string> = new Set(['typora', 'vscode', 'vscode-insiders', 'cursor', 'zed', 'xcode']);

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
  env?: NodeJS.ProcessEnv;
  filePath?: string;
  queryReg?: RegQuery;
}

function resolveBundlePath(
  spec: OpenInAppSpec,
  exists: (path: string) => boolean,
  home: string,
): string | null {
  if (spec.bundleName === undefined) return null;
  for (const dir of ['/Applications', '/System/Applications', join(home, 'Applications')]) {
    const candidate = join(dir, spec.bundleName);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function isSystemProvided(spec: OpenInAppSpec): boolean {
  return spec.id === 'finder' || spec.bundleId !== undefined;
}

function fileExtension(filePath: string | undefined): string {
  return filePath === undefined ? '' : extname(filePath).toLowerCase();
}

function detectMacBrowsers(exists: (path: string) => boolean, home: string): OpenInAppInfo[] {
  return BROWSER_SPECS.filter((spec) => resolveBundlePath(spec, exists, home) !== null).map(
    (spec) => ({ id: spec.id, label: spec.label, preferred: true }),
  );
}

function detectMacFileExtras(
  ext: string,
  exists: (path: string) => boolean,
  home: string,
): OpenInAppInfo[] {
  if (BROWSER_FILE_EXTS.has(ext)) return detectMacBrowsers(exists, home);
  if (PREVIEW_FILE_EXTS.has(ext)) {
    const preview =
      resolveBundlePath(PREVIEW_SPEC, exists, home) === null
        ? []
        : [{ id: PREVIEW_SPEC.id, label: PREVIEW_SPEC.label, preferred: true }];
    return ext === '.pdf' ? [...preview, ...detectMacBrowsers(exists, home)] : preview;
  }
  return [];
}

function dropEditorsForPdf(ext: string, apps: OpenInAppInfo[]): OpenInAppInfo[] {
  return ext === '.pdf' ? apps.filter((app) => !EDITOR_IDS.has(app.id)) : apps;
}

export async function listAvailableOpenInApps(deps: OpenInDetectDeps = {}): Promise<OpenInAppInfo[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const env = deps.env ?? process.env;
    const exists = deps.exists ?? defaultExists;
    const queryReg = deps.queryReg ?? queryRegValue;
    const detect = async (specs: readonly WindowsAppSpec[], preferred: boolean) => {
      const results = await Promise.all(
        specs.map(async (spec): Promise<OpenInAppInfo | null> => {
          if ((await spec.resolve(env, exists, queryReg)) === null) return null;
          return preferred
            ? { id: spec.id, label: spec.label, preferred: true }
            : { id: spec.id, label: spec.label };
        }),
      );
      return results.filter((info): info is OpenInAppInfo => info !== null);
    };
    const base = await detect(WINDOWS_APP_SPECS, false);
    const ext = fileExtension(deps.filePath);
    const markdownApps = MARKDOWN_FILE_EXTS.has(ext) ? await detect([WINDOWS_TYPORA_SPEC], false) : [];
    if (!WIN_BROWSER_FILE_EXTS.has(ext)) return [...markdownApps, ...base];
    const browsers = await detect(WINDOWS_BROWSER_SPECS, true);
    return [...browsers, ...markdownApps, ...dropEditorsForPdf(ext, base)];
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
  const ext = fileExtension(deps.filePath);
  const typora = MARKDOWN_FILE_EXTS.has(ext) && resolveBundlePath(TYPORA_SPEC, exists, home) !== null
    ? [{ id: TYPORA_SPEC.id, label: TYPORA_SPEC.label }]
    : [];
  return [...typora, ...detectMacFileExtras(ext, exists, home), ...dropEditorsForPdf(ext, available)];
}

interface WindowsAppSpec {
  id: OpenInAppId;
  label: string;
  resolve(
    env: NodeJS.ProcessEnv,
    exists: (path: string) => boolean,
    queryReg: RegQuery,
  ): string | null | Promise<string | null>;
  args?(dir: string, command: string, isDir: (path: string) => boolean): string[];
  consoleLaunch?(
    dir: string,
    command: string,
  ): { command: string; args: string[]; env?: NodeJS.ProcessEnv } | null;
}

const OPEN_IN_DIR_ENV = 'KIMI_CODE_OPEN_IN_DIR';

function firstExisting(paths: string[], exists: (path: string) => boolean): string | null {
  for (const candidate of paths) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

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
  return join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const APP_PATHS_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths';
const UNINSTALL_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

interface WindowsInstallFallback {
  appPathsExe?: string;
  registryInstallKeys?: ReadonlyArray<{ key: string; value: string }>;
  installDirExe: string;
  pathProbes?: ReadonlyArray<{ probe: string; exe: string }>;
}

function expandWindowsEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.includes('%')) return value;
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === name.toUpperCase()) {
        const replacement = env[key];
        if (replacement !== undefined) return replacement;
      }
    }
    return match;
  });
}

async function resolveWithInstallFallback(
  fixedCandidates: string[],
  fallback: WindowsInstallFallback,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  queryReg: RegQuery,
): Promise<string | null> {
  const fixed = firstExisting(fixedCandidates, exists);
  if (fixed !== null) return fixed;
  const registryCandidates: Array<Promise<string | null>> = [];
  if (fallback.appPathsExe !== undefined) {
    for (const hive of ['HKCU', 'HKLM']) {
      registryCandidates.push(queryReg(`${hive}\\${APP_PATHS_KEY}\\${fallback.appPathsExe}`, null));
    }
  }
  for (const { key, value } of fallback.registryInstallKeys ?? []) {
    registryCandidates.push(
      queryReg(key, value).then((location) =>
        location === null ? null : join(location, fallback.installDirExe),
      ),
    );
  }
  for (const candidate of await Promise.all(registryCandidates)) {
    if (candidate === null) continue;
    const expanded = expandWindowsEnvVars(candidate, env);
    if (exists(expanded)) return expanded;
  }
  for (const { probe, exe } of fallback.pathProbes ?? []) {
    for (const probePath of pathExeCandidates(env, probe)) {
      if (!exists(probePath)) continue;
      const candidate = join(dirname(probePath), exe);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function vscodeLikeFallback(
  appPathsExe: string,
  userUninstallGuid: string,
  systemUninstallGuid: string,
  pathCommand: string,
): WindowsInstallFallback {
  return {
    appPathsExe,
    registryInstallKeys: [
      { key: `HKCU\\${UNINSTALL_KEY}\\${userUninstallGuid}_is1`, value: 'InstallLocation' },
      { key: `HKLM\\${UNINSTALL_KEY}\\${systemUninstallGuid}_is1`, value: 'InstallLocation' },
    ],
    installDirExe: appPathsExe,
    pathProbes: [{ probe: pathCommand, exe: join('..', appPathsExe) }],
  };
}

const WINDOWS_TYPORA_SPEC: WindowsAppSpec = {
  id: 'typora',
  label: 'Typora',
  resolve: (env, exists, queryReg) =>
    resolveWithInstallFallback(
      editorExeCandidates(env, join('Typora', 'Typora.exe')),
      {
        appPathsExe: 'Typora.exe',
        installDirExe: 'Typora.exe',
        pathProbes: [{ probe: 'Typora.exe', exe: 'Typora.exe' }],
      },
      env,
      exists,
      queryReg,
    ),
  args: (file) => [file],
};

const WINDOWS_APP_SPECS: readonly WindowsAppSpec[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    resolve: (env, exists, queryReg) =>
      resolveWithInstallFallback(
        editorExeCandidates(env, join('Microsoft VS Code', 'Code.exe')),
        vscodeLikeFallback(
          'Code.exe',
          '{F8A2A208-72B3-4D61-95FC-8A65D340689B}',
          '{EA457B21-F73E-494C-ACAB-524FDE069978}',
          'code.cmd',
        ),
        env,
        exists,
        queryReg,
      ),
    args: (dir) => [dir],
  },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    resolve: (env, exists, queryReg) =>
      resolveWithInstallFallback(
        editorExeCandidates(env, join('Microsoft VS Code Insiders', 'Code - Insiders.exe')),
        vscodeLikeFallback(
          'Code - Insiders.exe',
          '{C26E74D1-022E-4238-8B9D-5E6714DE1650}',
          '{1287CAD5-7C8D-410D-88B9-0D1EE4A83FF2}',
          'code-insiders.cmd',
        ),
        env,
        exists,
        queryReg,
      ),
    args: (dir) => [dir],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    resolve: (env, exists, queryReg) =>
      resolveWithInstallFallback(
        editorExeCandidates(env, join('cursor', 'Cursor.exe'), join('Cursor', 'Cursor.exe')),
        {
          appPathsExe: 'Cursor.exe',
          installDirExe: 'Cursor.exe',
          pathProbes: [{ probe: 'cursor.cmd', exe: join('..', 'Cursor.exe') }],
        },
        env,
        exists,
        queryReg,
      ),
    args: (dir) => [dir],
  },
  {
    id: 'zed',
    label: 'Zed',
    resolve: (env, exists, queryReg) =>
      resolveWithInstallFallback(
        editorExeCandidates(env, join('Zed', 'Zed.exe')),
        {
          installDirExe: 'Zed.exe',
          pathProbes: [{ probe: 'zed.exe', exe: 'zed.exe' }],
        },
        env,
        exists,
        queryReg,
      ),
    args: (dir) => [dir],
  },
  {
    id: 'explorer',
    label: 'File Explorer',
    resolve: () => 'explorer.exe',
  },
  {
    id: 'windows-terminal',
    label: 'Terminal',
    resolve: terminalCommand,
    args: (dir) => ['-d', dir],
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
    resolve: (env, exists, queryReg) =>
      resolveWithInstallFallback(
        editorExeCandidates(env, join('Git', 'git-bash.exe')),
        {
          registryInstallKeys: [
            { key: 'HKCU\\SOFTWARE\\GitForWindows', value: 'InstallPath' },
            { key: 'HKLM\\SOFTWARE\\GitForWindows', value: 'InstallPath' },
          ],
          installDirExe: 'git-bash.exe',
          pathProbes: [
            { probe: 'git-bash.exe', exe: 'git-bash.exe' },
            { probe: 'git.exe', exe: join('..', 'git-bash.exe') },
          ],
        },
        env,
        exists,
        queryReg,
      ),
    args: (dir) => [`--cd=${dir}`],
  },
];

const WINDOWS_BROWSER_SPECS: readonly WindowsAppSpec[] = [
  {
    id: 'chrome',
    label: 'Chrome',
    resolve: (env, exists) =>
      firstExisting(
        [
          ...(env['LOCALAPPDATA'] === undefined
            ? []
            : [join(env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe')]),
          ...editorExeCandidates(env, join('Google', 'Chrome', 'Application', 'chrome.exe')),
        ],
        exists,
      ),
    args: (file) => [file],
  },
  {
    id: 'edge',
    label: 'Edge',
    resolve: (env, exists) =>
      firstExisting(
        [
          ...(env['LOCALAPPDATA'] === undefined
            ? []
            : [join(env['LOCALAPPDATA'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')]),
          ...editorExeCandidates(env, join('Microsoft', 'Edge', 'Application', 'msedge.exe')),
        ],
        exists,
      ),
    args: (file) => [file],
  },
  {
    id: 'firefox',
    label: 'Firefox',
    resolve: (env, exists) =>
      firstExisting(
        [
          ...(env['LOCALAPPDATA'] === undefined
            ? []
            : [join(env['LOCALAPPDATA'], 'Mozilla Firefox', 'firefox.exe')]),
          ...editorExeCandidates(env, join('Mozilla Firefox', 'firefox.exe')),
        ],
        exists,
      ),
    args: (file) => [file],
  },
  {
    id: 'brave',
    label: 'Brave',
    resolve: (env, exists) =>
      firstExisting(
        [
          ...(env['LOCALAPPDATA'] === undefined
            ? []
            : [join(env['LOCALAPPDATA'], 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]),
          ...editorExeCandidates(env, join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
        ],
        exists,
      ),
    args: (file) => [file],
  },
];

export const OPEN_IN_APP_IDS: readonly OpenInAppId[] = [
  ...new Set(
    [TYPORA_SPEC, ...APP_SPECS, ...BROWSER_SPECS, PREVIEW_SPEC, WINDOWS_TYPORA_SPEC, ...WINDOWS_APP_SPECS, ...WINDOWS_BROWSER_SPECS].map(
      (spec) => spec.id,
    ),
  ),
];

function defaultIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return true;
  }
}

function buildOpenArgs(
  spec: OpenInAppSpec,
  targetPath: string,
  exists: (path: string) => boolean,
  home: string,
  isDir: (path: string) => boolean,
): string[] | null {
  if (spec.id === 'finder') return isDir(targetPath) ? [targetPath] : ['-R', targetPath];
  if (spec.bundleId !== undefined) return ['-b', spec.bundleId, targetPath];
  const appPath = resolveBundlePath(spec, exists, home);
  if (appPath === null) return null;
  return ['-a', appPath, targetPath];
}

export interface OpenInRunDeps extends OpenInDetectDeps {
  shell?: Pick<typeof import('electron').shell, 'openPath' | 'showItemInFolder'>;
  isDir?: (path: string) => boolean;
  lstat?: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean };
  run?: (command: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;
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
  const spec = [WINDOWS_TYPORA_SPEC, ...WINDOWS_APP_SPECS, ...WINDOWS_BROWSER_SPECS].find((candidate) => candidate.id === appId);
  if (spec === undefined) return { ok: false, error: `unknown open-in app: ${appId}` };
  if (appId === 'explorer') {
    try {
      const path = win32.normalize(targetPath);
      const isDir = (deps.isDir ?? ((value) => statSync(value).isDirectory()))(path);
      const shell = deps.shell ?? (await import('electron')).shell;
      if (isDir) {
        const error = await shell.openPath(path);
        return error === '' ? { ok: true } : { ok: false, error };
      }
      shell.showItemInFolder(path);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const command = await spec.resolve(
    deps.env ?? process.env,
    deps.exists ?? defaultExists,
    deps.queryReg ?? queryRegValue,
  );
  if (command === null) return { ok: false, error: `${spec.label} is not installed` };
  const isDir = deps.isDir ?? defaultIsDir;
  const consoleLaunch = spec.consoleLaunch?.(targetPath, command) ?? null;
  const launch = consoleLaunch ?? { command, args: spec.args?.(targetPath, command, isDir) ?? [] };
  const run = deps.runDetached ?? runDetached;
  const { error } = await run(launch.command, launch.args, {
    consoleWindow: consoleLaunch !== null,
    env: consoleLaunch?.env,
  });
  return error === null ? { ok: true } : { ok: false, error };
}

export async function openInApp(
  appId: string,
  targetPath: string,
  deps: OpenInRunDeps = {},
): Promise<OpenInResult> {
  const platform = deps.platform ?? process.platform;
  if (appId === 'file-manager') {
    if (platform !== 'linux') return { ok: false, error: 'file-manager is only supported on Linux' };
    if (!(deps.isDir ?? defaultIsDir)(targetPath)) return { ok: false, error: 'file-manager only supports directories' };
    const shell = deps.shell ?? (await import('electron')).shell;
    const error = await shell.openPath(targetPath);
    return error === '' ? { ok: true } : { ok: false, error };
  }
  if (appId === 'system') {
    if (platform === 'win32') targetPath = win32.normalize(targetPath);
    const lstat = deps.lstat ?? ((path: string) => lstatSync(path));
    let entry: { isFile(): boolean; isSymbolicLink(): boolean };
    try {
      entry = lstat(targetPath);
    } catch {
      return { ok: false, error: 'path does not exist' };
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return { ok: false, error: 'system open only supports regular files' };
    }
    if (!/\.(png|jpe?g|jfif|gif|webp|svg|avif|bmp|ico|tiff?|heic|html?|md|markdown|mdx)$/i.test(targetPath) && !isOfficeDocumentPath(targetPath)) {
      return { ok: false, error: 'system open only supports image, HTML, Markdown, or Office document files' };
    }
    const shell = deps.shell ?? (await import('electron')).shell;
    const error = await shell.openPath(targetPath);
    return error === '' ? { ok: true } : { ok: false, error };
  }
  if (platform === 'win32') return openInAppWindows(appId, targetPath, deps);
  const spec = [TYPORA_SPEC, ...APP_SPECS, ...BROWSER_SPECS, PREVIEW_SPEC].find((candidate) => candidate.id === appId);
  if (!spec) return { ok: false, error: `unknown open-in app: ${appId}` };
  if (platform !== 'darwin') return { ok: false, error: 'open-in is only supported on macOS and Windows' };
  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();
  const args = buildOpenArgs(spec, targetPath, exists, home, deps.isDir ?? defaultIsDir);
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
