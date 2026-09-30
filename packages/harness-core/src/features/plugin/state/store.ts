import { join } from 'pathe';

import { HostFsError, type OsFsPort } from '#/features/os/host/index';

import { PluginError } from '../errors';
import type { PluginCapabilityState, PluginGithubMetadata, PluginSource } from '../types';

const INSTALLED_REL = join('plugins', 'installed.json');

export interface InstalledRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly originalSource?: string;
  readonly capabilities?: PluginCapabilityState;
  readonly github?: PluginGithubMetadata;
}

export interface InstalledFile {
  readonly version: 1;
  readonly plugins: readonly InstalledRecord[];
}

const EMPTY: InstalledFile = { version: 1, plugins: [] };

export async function readInstalled(fs: OsFsPort, kimiHomeDir: string): Promise<InstalledFile> {
  const filePath = join(kimiHomeDir, INSTALLED_REL);
  let text: string;
  try {
    text = await fs.readText(filePath);
  } catch (error) {
    if (error instanceof HostFsError && error.code === 'os.fs.not_found') return EMPTY;
    throw error;
  }
  let parsed: InstalledFile;
  try {
    parsed = JSON.parse(text) as InstalledFile;
  } catch (error) {
    throw new PluginError(
      'plugin.load_failed',
      `Failed to parse ${filePath}: ${(error as Error).message}`,
      { cause: error, details: { path: filePath } },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.plugins)) {
    throw new PluginError(
      'plugin.load_failed',
      `Failed to parse ${filePath}: installed.json is not a valid InstalledFile object`,
      { details: { path: filePath } },
    );
  }
  return parsed;
}

export async function writeInstalled(
  fs: OsFsPort,
  kimiHomeDir: string,
  data: InstalledFile,
): Promise<void> {
  const dir = join(kimiHomeDir, 'plugins');
  await fs.mkdir(dir, { recursive: true });
  const final = join(dir, 'installed.json');
  const tmp = `${final}.tmp`;
  await fs.writeText(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, final);
}
