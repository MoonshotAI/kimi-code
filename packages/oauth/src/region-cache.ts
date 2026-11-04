import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { KimiRegion } from './region';

export const KIMI_REGION_CACHE_FILENAME = 'region.json';

export interface KimiRegionCacheRecord {
  readonly version: 1;
  readonly authState: 'logged-out';
  readonly region: KimiRegion;
  readonly source: 'local-signals';
}

function cachePath(homeDir: string): string {
  return join(homeDir, KIMI_REGION_CACHE_FILENAME);
}

function parseCache(raw: string): KimiRegionCacheRecord | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value['version'] === 1 &&
      value['authState'] === 'logged-out' &&
      (value['region'] === 'mainland-cn' || value['region'] === 'global') &&
      value['source'] === 'local-signals'
    ) {
      return {
        version: 1,
        authState: 'logged-out',
        region: value['region'],
        source: 'local-signals',
      };
    }
  } catch {}
  return undefined;
}

export function readKimiRegionCache(homeDir: string): KimiRegionCacheRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(cachePath(homeDir), 'utf-8');
  } catch {
    return undefined;
  }
  const cached = parseCache(raw);
  if (cached === undefined) clearKimiRegionCache(homeDir);
  return cached;
}

export function writeKimiRegionCache(homeDir: string, region: KimiRegion): void {
  const record: KimiRegionCacheRecord = {
    version: 1,
    authState: 'logged-out',
    region,
    source: 'local-signals',
  };
  try {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(homeDir), `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {}
}

export function clearKimiRegionCache(homeDir: string): void {
  try {
    unlinkSync(cachePath(homeDir));
  } catch {}
}
