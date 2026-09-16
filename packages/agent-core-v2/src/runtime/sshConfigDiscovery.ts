import { join } from 'pathe';

import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

export function parseSshConfigHosts(text: string): readonly string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;
    const match = /^([^\s=]+)[\s=]+(.*)$/.exec(line);
    if (match === null) continue;
    if (match[1]!.toLowerCase() !== 'host') continue;
    for (const pattern of match[2]!.split(/\s+/)) {
      if (pattern.length === 0) continue;
      if (pattern.includes('*') || pattern.includes('?') || pattern.startsWith('!')) continue;
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      hosts.push(pattern);
    }
  }
  return hosts;
}

export async function readSshConfigHosts(
  fs: IHostFileSystem,
  homeDir: string,
): Promise<readonly string[]> {
  let text: string;
  try {
    text = await fs.readText(join(homeDir, '.ssh', 'config'));
  } catch (error: unknown) {
    if (error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND) return [];
    throw error;
  }
  return parseSshConfigHosts(text);
}
