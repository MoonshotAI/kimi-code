import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PluginCapabilityState, PluginSource } from './types';

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
}

export interface InstalledFile {
  readonly version: 1;
  readonly plugins: readonly InstalledRecord[];
}

const EMPTY: InstalledFile = { version: 1, plugins: [] };

export async function readInstalled(kimiHomeDir: string): Promise<InstalledFile> {
  // 临时阅读注释：installed.json 是唯一的安装状态来源；缺文件代表用户还没安装任何插件。
  const filePath = path.join(kimiHomeDir, INSTALLED_REL);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as InstalledFile;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.plugins)) {
      throw new Error('installed.json is not a valid InstalledFile object');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to parse ${filePath}: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

export async function writeInstalled(
  kimiHomeDir: string,
  data: InstalledFile,
): Promise<void> {
  // 临时阅读注释：先写临时文件再 rename，避免进程中断时留下半截 JSON。
  const dir = path.join(kimiHomeDir, 'plugins');
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, 'installed.json');
  const tmp = `${final}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, final);
}
