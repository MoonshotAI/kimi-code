import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { app } from 'electron';

interface WindowsBashRuntimeOptions {
  readonly platform?: string;
  readonly env?: Record<string, string | undefined>;
  readonly runtimeRoot?: string;
  readonly packaged?: boolean;
  readonly appPath?: string;
  readonly resourcesPath?: string;
  readonly fileExists?: (path: string) => boolean;
}

const requiredFiles = [
  'usr\\bin\\bash.exe',
  'usr\\bin\\cygpath.exe',
  'usr\\bin\\msys-2.0.dll',
];

function normalizedPath(path: string): string {
  return win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase();
}

function prependPath(env: Record<string, string | undefined>, directory: string): void {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const entries = env[key]?.split(';').filter((entry) => entry.length > 0) ?? [];
  if (entries.some((entry) => normalizedPath(entry) === normalizedPath(directory))) return;
  env[key] = [directory, ...entries].join(';');
}

export function configureWindowsBashRuntime(options: WindowsBashRuntimeOptions = {}): string | undefined {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  const env = options.env ?? process.env;
  if (env['KIMI_SHELL_PATH']?.trim()) return undefined;
  const root = options.runtimeRoot ?? ((options.packaged ?? app.isPackaged)
    ? win32.join(options.resourcesPath ?? process.resourcesPath, 'windows-bash')
    : win32.join(options.appPath ?? app.getAppPath(), 'resources-stage', 'windows-bash'));
  const fileExists = options.fileExists ?? existsSync;
  for (const relative of requiredFiles) {
    if (!fileExists(win32.join(root, relative))) {
      throw new Error(`Windows Bash runtime is incomplete at ${root}: missing ${relative}`);
    }
  }
  const binDir = win32.join(root, 'usr', 'bin');
  const shellPath = win32.join(binDir, 'bash.exe');
  env['KIMI_SHELL_PATH'] = shellPath;
  prependPath(env, binDir);
  return shellPath;
}
