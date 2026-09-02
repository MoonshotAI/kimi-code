import { isAbsolute, join, resolve, win32 } from 'node:path';

export interface LegacySourceResolution {
  readonly sourceHome: string;
  readonly origin: 'default' | 'share-dir';
  readonly skillsSourceHome?: string;
}

export function resolveLegacySourceHome(
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
): LegacySourceResolution {
  const defaultHome = join(home, '.kimi');
  const shareDir = env['KIMI_SHARE_DIR'];
  if (shareDir === undefined || shareDir.trim() === '') {
    return { sourceHome: defaultHome, origin: 'default' };
  }
  const sourceHome = isAbsolute(shareDir) ? resolve(shareDir) : resolve(cwd, shareDir);
  const skillsSourceHome = sourceHome === defaultHome ? undefined : defaultHome;
  return { sourceHome, origin: 'share-dir', skillsSourceHome };
}

export function sameLegacyPath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}
