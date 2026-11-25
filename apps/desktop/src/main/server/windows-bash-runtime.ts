import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { app } from 'electron';
import type { WindowsBashRuntimeEnv } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostServices';

interface WindowsBashRuntimeOptions {
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
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

export function resolveWindowsBashEnv(options: WindowsBashRuntimeOptions = {}): WindowsBashRuntimeEnv | undefined {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  const env = options.env ?? process.env;
  const shellKey = Object.keys(env).find((name) => name.toUpperCase() === 'KIMI_SHELL_PATH');
  if (shellKey !== undefined && env[shellKey]?.trim()) return undefined;
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
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const entries = env[pathKey]?.split(';').filter(Boolean) ?? [];
  const normalizedBin = normalizedPath(binDir);
  const bundled = (entry: string) => normalizedPath(entry) === normalizedBin;
  const runtime = {
    KIMI_SHELL_PATH: win32.join(binDir, 'bash.exe'),
    [pathKey]: [entries.find(bundled) ?? binDir, ...entries.filter(entry => !bundled(entry))].join(';'),
  };
  if (!env['HOME'] && !(env['HOMEDRIVE'] && env['HOMEPATH']) && env['USERPROFILE']) {
    runtime['HOME'] = env['USERPROFILE'];
  }
  return runtime;
}
