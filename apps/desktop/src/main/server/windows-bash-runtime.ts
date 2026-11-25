import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm, stat, symlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
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

function checkRuntime(root: string, fileExists: (path: string) => boolean): void {
  for (const relative of requiredFiles) {
    if (!fileExists(win32.join(root, relative))) {
      throw new Error(`Windows Bash runtime is incomplete at ${root}: missing ${relative}`);
    }
  }
}

async function rootForTemp(root: string, temp: string): Promise<string> {
  const standardTemp = win32.join(userInfo().homedir, 'AppData', 'Local', 'Temp');
  if (normalizedPath(temp) === normalizedPath(standardTemp)) return root;

  const manifest = await stat(win32.join(root, 'source-manifest.json'), { bigint: true });
  const key = createHash('sha256').update(JSON.stringify([
    root, temp, app.getVersion(), String(manifest.ino), String(manifest.ctimeNs),
  ])).digest('hex');
  const cache = win32.join(app.getPath('userData'), 'windows-bash');
  const destination = win32.join(cache, key);
  if (existsSync(destination)) return destination;
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(win32.join(cache, '.prepare-'));
  try {
    const sharedDirectories = new Set([win32.join(root, 'usr', 'share'), win32.join(root, 'usr', 'lib')]);
    await cp(root, staging, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: async (from, to) => {
        if (!sharedDirectories.has(from)) return true;
        try {
          await symlink(from, to, 'junction');
        } catch {
          return true;
        }
        return false;
      },
    });
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!existsSync(destination)) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return destination;
}

export async function resolveWindowsBashEnv(options: WindowsBashRuntimeOptions = {}): Promise<WindowsBashRuntimeEnv | undefined> {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  const env = options.env ?? process.env;
  const shellKey = Object.keys(env).find((name) => name.toUpperCase() === 'KIMI_SHELL_PATH');
  if (shellKey !== undefined && env[shellKey]?.trim()) return undefined;
  const root = options.runtimeRoot ?? ((options.packaged ?? app.isPackaged)
    ? win32.join(options.resourcesPath ?? process.resourcesPath, 'windows-bash')
    : win32.join(options.appPath ?? app.getAppPath(), 'resources-stage', 'windows-bash'));
  const fileExists = options.fileExists ?? existsSync;
  checkRuntime(root, fileExists);
  const temp = env['TMP'] || env['TEMP'] || env['USERPROFILE'] || env['SystemRoot'];
  const runtimeRoot = temp ? await rootForTemp(root, win32.resolve(temp)) : root;
  if (runtimeRoot !== root) checkRuntime(runtimeRoot, fileExists);
  const binDir = win32.join(runtimeRoot, 'usr', 'bin');
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const entries = env[pathKey]?.split(';').filter(Boolean) ?? [];
  const normalizedBin = normalizedPath(binDir);
  const bundled = (entry: string) => normalizedPath(entry) === normalizedBin;
  const runtime = {
    KIMI_SHELL_PATH: win32.join(binDir, 'bash.exe'),
    [pathKey]: [entries.find(bundled) ?? binDir, ...entries.filter(entry => !bundled(entry))].join(';'),
  };
  const home = env['HOMEDRIVE'] && env['HOMEPATH']
    ? win32.join(env['HOMEDRIVE'], env['HOMEPATH'])
    : env['USERPROFILE'];
  if (!env['HOME'] && home) runtime['HOME'] = home;
  return runtime;
}
