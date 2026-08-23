import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Error2, ErrorCodes } from '#/errors';

import type { PluginCapabilityState, PluginGithubMetadata, PluginSource } from './types';

const INSTALLED_REL = path.join('plugins', 'installed.json');

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

export async function readInstalled(kimiHomeDir: string): Promise<InstalledFile> {
  const filePath = path.join(kimiHomeDir, INSTALLED_REL);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw error;
  }
  let parsed: InstalledFile;
  try {
    parsed = JSON.parse(text) as InstalledFile;
  } catch (error) {
    throw new Error2(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Failed to parse ${filePath}: ${(error as Error).message}`,
      { cause: error, details: { path: filePath } },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.plugins)) {
    throw new Error2(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Failed to parse ${filePath}: installed.json is not a valid InstalledFile object`,
      { details: { path: filePath } },
    );
  }
  return parsed;
}

export async function writeInstalled(kimiHomeDir: string, data: InstalledFile): Promise<void> {
  const dir = path.join(kimiHomeDir, 'plugins');
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, 'installed.json');
  const tmp = `${final}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, final);
}
