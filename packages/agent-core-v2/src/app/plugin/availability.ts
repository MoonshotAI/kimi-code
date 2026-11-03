import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  readonly checkedAt: string;
}

export interface PluginAvailabilityFile {
  readonly version: 1;
  readonly sources: Readonly<Record<string, Readonly<Record<string, PluginAvailabilityEntry>>>>;
}

type AvailabilityRecord = Pick<PluginRecord, 'id' | 'origin' | 'catalogId' | 'marketplaceSource'>;

const EMPTY: PluginAvailabilityFile = { version: 1, sources: {} };

function normalizeSource(source: string): string {
  return source.trim();
}

function availabilityValue(entry: PluginAvailabilityEntry): string {
  return JSON.stringify({
    clients: entry.clients === undefined ? undefined : [...entry.clients].toSorted(),
    platforms: entry.platforms === undefined ? undefined : [...entry.platforms].toSorted(),
  });
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
      checkedAt,
    },
  ]));
}

async function readAvailability(kimiHomeDir: string): Promise<PluginAvailabilityFile> {
  try {
    const text = await readFile(path.join(kimiHomeDir, 'plugins', 'availability.json'), 'utf8');
    const parsed = JSON.parse(text) as PluginAvailabilityFile;
    if (parsed.version !== 1 || typeof parsed.sources !== 'object' || parsed.sources === null) {
      return EMPTY;
    }
    return parsed;
  } catch {
    return EMPTY;
  }
}

export class PluginAvailabilityStore {
  private readonly filePath: string;
  private current: PluginAvailabilityFile = EMPTY;

  constructor(kimiHomeDir: string) {
    this.filePath = path.join(kimiHomeDir, 'plugins', 'availability.json');
  }

  async refresh(): Promise<void> {
    this.current = await readAvailability(path.dirname(path.dirname(this.filePath)));
  }

  async update(marketplace: PluginMarketplace): Promise<boolean> {
    const source = normalizeSource(marketplace.source);
    const checkedAt = new Date().toISOString();
    const incoming = catalogEntries(marketplace, checkedAt);
    const existing = this.current.sources[source] ?? {};
    const changed = Object.entries(incoming).some(([id, entry]) =>
      existing[id] === undefined || availabilityValue(existing[id]) !== availabilityValue(entry)
    );
    if (!changed) return false;
    const latest = await readAvailability(path.dirname(path.dirname(this.filePath)));
    const next: PluginAvailabilityFile = {
      version: 1,
      sources: {
        ...latest.sources,
        [source]: { ...latest.sources[source], ...incoming },
      },
    };
    const temporary = `${this.filePath}.tmp`;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
      await rename(temporary, this.filePath);
    } catch {
      this.current = next;
      return true;
    }
    this.current = next;
    return true;
  }

  entryFor(record: AvailabilityRecord): PluginAvailabilityEntry | undefined {
    if (record.origin === 'custom') return undefined;
    const catalogId = record.catalogId ?? (record.origin === 'unknown' ? record.id : undefined);
    if (catalogId === undefined) return undefined;
    if (record.marketplaceSource !== undefined) {
      return this.current.sources[normalizeSource(record.marketplaceSource)]?.[catalogId];
    }
    const matches = Object.values(this.current.sources)
      .map((entries) => entries[catalogId])
      .filter((entry): entry is PluginAvailabilityEntry => entry !== undefined);
    return matches.length === 1 ? matches[0] : undefined;
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
}
