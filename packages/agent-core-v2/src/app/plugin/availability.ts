import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import {
  marketplaceEntryInstallableOnHost,
  type PluginClient,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
  type PluginMarketplacePlatform,
} from './marketplace';
import type { PluginRecord } from './types';

export interface PluginAvailabilityEntry {
  readonly clients?: readonly PluginClient[];
  readonly platforms?: readonly PluginMarketplacePlatform[];
  readonly artifactSourceKey?: string;
  readonly checkedAt: string;
}

export interface PluginAvailabilityFile {
  readonly version: 1;
  readonly sources: Readonly<Record<string, Readonly<Record<string, PluginAvailabilityEntry>>>>;
}

type AvailabilityRecord = Pick<
  PluginRecord,
  'id' | 'origin' | 'catalogId' | 'marketplaceSource' | 'originalSource'
>;

const EMPTY: PluginAvailabilityFile = { version: 1, sources: {} };

export function pluginAvailabilitySourceKey(source: string): string {
  const normalized = source.trim();
  if (/^sha256:[a-f0-9]{64}$/.test(normalized)) return normalized;
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function availabilityValue(entry: PluginAvailabilityEntry): string {
  return JSON.stringify({
    clients: entry.clients === undefined ? undefined : [...entry.clients].toSorted(),
    platforms: entry.platforms === undefined ? undefined : [...entry.platforms].toSorted(),
  });
}

function availabilityFileValue(file: PluginAvailabilityFile): string {
  const sources = Object.entries(file.sources)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(
    sources.map(([source, entries]) => [
      source,
      Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, {
        value: availabilityValue(entry),
        artifactSourceKey: entry.artifactSourceKey,
      }])),
    ]),
  ));
}

function catalogEntries(
  marketplace: PluginMarketplace,
  checkedAt: string,
): Readonly<Record<string, PluginAvailabilityEntry>> {
  return Object.fromEntries(marketplace.plugins.map((entry) => [
    entry.id,
    {
      clients: entry.clients,
      platforms: entry.platforms,
      artifactSourceKey: pluginAvailabilitySourceKey(entry.source),
      checkedAt,
    },
  ]));
}

function availabilityObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid plugin availability cache');
  }
  return value as Record<string, unknown>;
}

function availabilityStrings(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Invalid plugin availability cache');
  }
  return value;
}

function availabilityString(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('Invalid plugin availability cache');
  }
  return value;
}

function migrateAvailabilityEntry(value: unknown): PluginAvailabilityEntry {
  const entry = availabilityObject(value);
  const checkedAt = availabilityString(entry['checkedAt']);
  if (checkedAt === undefined) throw new Error('Invalid plugin availability cache');
  const artifactSource = availabilityString(entry['artifactSource']);
  return {
    clients: availabilityStrings(entry['clients']) as readonly PluginClient[] | undefined,
    platforms: availabilityStrings(entry['platforms']) as
      | readonly PluginMarketplacePlatform[]
      | undefined,
    artifactSourceKey: availabilityString(entry['artifactSourceKey']) ??
      (artifactSource === undefined ? undefined : pluginAvailabilitySourceKey(artifactSource)),
    checkedAt,
  };
}

async function readAvailability(kimiHomeDir: string): Promise<PluginAvailabilityFile> {
  try {
    const text = await readFile(path.join(kimiHomeDir, 'plugins', 'availability.json'), 'utf8');
    const parsed = availabilityObject(JSON.parse(text));
    if (parsed['version'] !== 1) throw new Error('Invalid plugin availability cache');
    const sources = availabilityObject(parsed['sources']);
    return {
      version: 1,
      sources: Object.fromEntries(Object.entries(sources).map(([source, value]) => [
        pluginAvailabilitySourceKey(source),
        Object.fromEntries(Object.entries(availabilityObject(value)).map(([id, entry]) => [
          id,
          migrateAvailabilityEntry(entry),
        ])),
      ])),
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return EMPTY;
    }
    throw error;
  }
}

export class PluginAvailabilityStore {
  private readonly filePath: string;
  private current: PluginAvailabilityFile = EMPTY;
  private generationValue = 0;

  constructor(kimiHomeDir: string) {
    this.filePath = path.join(kimiHomeDir, 'plugins', 'availability.json');
  }

  get generation(): number {
    return this.generationValue;
  }

  async refresh(): Promise<void> {
    this.replaceCurrent(await readAvailability(path.dirname(path.dirname(this.filePath))));
  }

  async update(marketplace: PluginMarketplace): Promise<boolean> {
    const source = pluginAvailabilitySourceKey(marketplace.source);
    const checkedAt = new Date().toISOString();
    const incoming = catalogEntries(marketplace, checkedAt);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const release = await lockfile.lock(`${this.filePath}.lock`, {
      retries: { retries: 120, factor: 1, minTimeout: 50, maxTimeout: 200 },
      stale: 5_000,
      realpath: false,
    });
    let temporary: string | undefined;
    try {
      const latest = await readAvailability(path.dirname(path.dirname(this.filePath)));
      const existing = latest.sources[source] ?? {};
      const changed = Object.entries(incoming).some(([id, entry]) =>
        existing[id] === undefined || availabilityValue(existing[id]) !== availabilityValue(entry)
      );
      if (!changed) {
        this.replaceCurrent(latest);
        return false;
      }
      const next: PluginAvailabilityFile = {
        version: 1,
        sources: {
          ...latest.sources,
          [source]: { ...latest.sources[source], ...incoming },
        },
      };
      temporary = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
      await rename(temporary, this.filePath);
      this.replaceCurrent(next);
      return true;
    } finally {
      if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => undefined);
      await release();
    }
  }

  entryFor(record: AvailabilityRecord): PluginAvailabilityEntry | undefined {
    if (record.origin === 'custom') return undefined;
    const catalogId = record.catalogId ?? (record.origin === 'unknown' ? record.id : undefined);
    if (catalogId === undefined) return undefined;
    const originalSourceKey = record.originalSource === undefined
      ? undefined
      : pluginAvailabilitySourceKey(record.originalSource);
    if (record.marketplaceSource !== undefined) {
      const entry = this.current.sources[pluginAvailabilitySourceKey(record.marketplaceSource)]?.[catalogId];
      if (
        record.origin === 'unknown' &&
        (entry?.artifactSourceKey === undefined || entry.artifactSourceKey !== originalSourceKey)
      ) {
        return undefined;
      }
      return entry;
    }
    const matches = Object.values(this.current.sources)
      .map((entries) => entries[catalogId])
      .filter((entry): entry is PluginAvailabilityEntry => entry !== undefined);
    if (record.origin === 'unknown') {
      const provenanceMatches = matches.filter(
        (entry) => entry.artifactSourceKey !== undefined && entry.artifactSourceKey === originalSourceKey,
      );
      if (provenanceMatches.length === 1) return provenanceMatches[0];
      return provenanceMatches.length === 0
        ? undefined
        : { clients: [], platforms: [], checkedAt: '' };
    }
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) return undefined;
    const provenanceMatches = matches.filter(
      (entry) => entry.artifactSourceKey !== undefined && entry.artifactSourceKey === originalSourceKey,
    );
    if (provenanceMatches.length === 1) return provenanceMatches[0];
    return { clients: [], platforms: [], checkedAt: '' };
  }

  supports(record: AvailabilityRecord, client: PluginClient, platform: NodeJS.Platform): boolean {
    const entry = this.entryFor(record);
    return entry === undefined || marketplaceEntryInstallableOnHost(entry, client, platform);
  }

  entrySupportsHost(
    entry: Pick<PluginMarketplaceEntry, 'clients' | 'platforms'>,
    client: PluginClient,
    platform: NodeJS.Platform,
  ): boolean {
    return marketplaceEntryInstallableOnHost(entry, client, platform);
  }

  private replaceCurrent(next: PluginAvailabilityFile): void {
    if (availabilityFileValue(this.current) !== availabilityFileValue(next)) {
      this.generationValue += 1;
    }
    this.current = next;
  }
}
