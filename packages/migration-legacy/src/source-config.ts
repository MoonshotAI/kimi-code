import { readFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';

import { sourceConfigJson, sourceConfigToml } from './paths.js';

export type SourceConfig =
  | { readonly kind: 'toml'; readonly parsed: Record<string, unknown> }
  | { readonly kind: 'json'; readonly parsed: Record<string, unknown> }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly path: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export async function readSourceConfig(sourceHome: string): Promise<SourceConfig> {
  const tomlPath = sourceConfigToml(sourceHome);
  let tomlText: string | undefined;
  try {
    tomlText = await readFile(tomlPath, 'utf-8');
  } catch (error) {
    // Only a missing file falls through to the JSON-era config; any other read
    // failure (permissions, I/O) is a data problem the report must surface.
    if (!isEnoent(error)) return { kind: 'unreadable', path: tomlPath };
  }
  if (tomlText !== undefined) {
    try {
      const parsed: unknown = parseToml(tomlText);
      return { kind: 'toml', parsed: isRecord(parsed) ? parsed : {} };
    } catch {
      return { kind: 'unreadable', path: tomlPath };
    }
  }

  const jsonPath = sourceConfigJson(sourceHome);
  let jsonText: string | undefined;
  try {
    jsonText = await readFile(jsonPath, 'utf-8');
  } catch (error) {
    if (!isEnoent(error)) return { kind: 'unreadable', path: jsonPath };
    return { kind: 'missing' };
  }
  try {
    const parsed: unknown = JSON.parse(jsonText);
    return { kind: 'json', parsed: isRecord(parsed) ? parsed : {} };
  } catch {
    return { kind: 'unreadable', path: jsonPath };
  }
}
