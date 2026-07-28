/**
 * `plugin` domain (L3) — owns the on-disk `installed.json` record store.
 *
 * Reads, validates, and atomically rewrites the installed-plugin file for
 * `PluginManager`. Records are validated rather than cast because the file is
 * hand-editable and survives downgrades; every schema is loose at every level
 * so a record written by a newer client round-trips through an older one.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { PluginCapabilityState, PluginGithubMetadata, PluginSource } from './types';

const INSTALLED_REL = path.join('plugins', 'installed.json');

const PluginSourceSchema: z.ZodType<PluginSource> = z.enum(['local-path', 'zip-url', 'github']);

const PluginGithubMetadataSchema: z.ZodType<PluginGithubMetadata> = z.looseObject({
  owner: z.string(),
  repo: z.string(),
  ref: z.looseObject({
    kind: z.enum(['branch', 'tag', 'sha']),
    value: z.string(),
  }),
  installedSha: z.string().optional(),
});

const PluginCapabilityStateSchema: z.ZodType<PluginCapabilityState> = z.looseObject({
  mcpServers: z.record(z.string(), z.looseObject({ enabled: z.boolean() })).optional(),
});

const InstalledRecordSchema = z.looseObject({
  id: z.string(),
  root: z.string(),
  source: PluginSourceSchema,
  enabled: z.boolean(),
  installedAt: z.string(),
  updatedAt: z.string().optional(),
  originalSource: z.string().optional(),
  capabilities: PluginCapabilityStateSchema.optional(),
  github: PluginGithubMetadataSchema.optional(),
});

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
  try {
    const parsed = JSON.parse(text) as InstalledFile;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.plugins)) {
      throw new Error('installed.json is not a valid InstalledFile object');
    }
    const plugins = parsed.plugins.map((entry, index) => {
      const record = InstalledRecordSchema.safeParse(entry);
      if (!record.success) {
        throw new Error(
          `plugins[${index}] is not a valid installed record: ${record.error.message}`,
          { cause: record.error },
        );
      }
      return record.data as InstalledRecord;
    });
    return { ...parsed, plugins };
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${(error as Error).message}`, { cause: error });
  }
}

export async function writeInstalled(kimiHomeDir: string, data: InstalledFile): Promise<void> {
  const dir = path.join(kimiHomeDir, 'plugins');
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, 'installed.json');
  const tmp = `${final}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, final);
}
