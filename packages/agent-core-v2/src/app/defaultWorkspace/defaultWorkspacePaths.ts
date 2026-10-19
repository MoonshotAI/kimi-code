import { posix, win32 } from 'node:path';

import { normalize } from 'pathe';

export const DEFAULT_WORKSPACE_RELATIVE_ROOT = ['KimiCode', 'Default'] as const;

const WINDOWS_QUALIFIED_ROOT = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

export function resolveCustomRoot(
  raw: string,
  osHomeDir: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === 'win32') {
    const expanded = /^~(?=$|[\\/])/.test(raw) ? osHomeDir + raw.slice(1) : raw;
    return WINDOWS_QUALIFIED_ROOT.test(expanded) ? normalize(win32.normalize(expanded)) : undefined;
  }
  const expanded = /^~(?=$|\/)/.test(raw) ? osHomeDir + raw.slice(1) : raw;
  return posix.isAbsolute(expanded) ? posix.normalize(expanded) : undefined;
}
