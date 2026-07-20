/**
 * `config` domain (L2) — TOML read/write transforms.
 *
 * Generic snake_case ↔ camelCase machinery plus the registry-aware entry points
 * (`transformTomlData` / `applySectionToToml`) that dispatch to a section's
 * registered `fromToml` / `toToml` hook. Per-domain normalization lives with
 * the section owner (see each domain's `configSection.ts`); this module stays
 * free of any other domain's semantics.
 *
 * Files store keys in snake_case; in-memory values are camelCase. Unknown
 * top-level keys are preserved by the caller (`ConfigService` keeps a raw
 * snake_case clone for round-trip).
 */

import { TomlError } from 'smol-toml';

import type { IConfigRegistry } from './config';
import { describeUnknownError, isPlainObject } from './configPure';

export { TomlError };
export { isPlainObject } from './configPure';

export function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch: string) => `_${ch.toLowerCase()}`);
}

export function transformPlainObject(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

export function plainObjectToToml(value: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const out = cloneRecord(raw);
  for (const [key, entry] of Object.entries(value)) {
    setDefined(out, camelToSnake(key), entry);
  }
  return out;
}

function defaultFromToml(value: unknown): unknown {
  return isPlainObject(value) ? transformPlainObject(value) : value;
}

export function transformTomlData(
  data: Record<string, unknown>,
  registry: IConfigRegistry,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const domain = snakeToCamel(key);
    const fromToml = registry.getSection(domain)?.fromToml;
    result[domain] = fromToml === undefined ? defaultFromToml(value) : fromToml(value);
  }
  return result;
}

export function applySectionToToml(
  rawSnake: Record<string, unknown>,
  domain: string,
  value: unknown,
  registry: IConfigRegistry,
): void {
  const snakeKey = camelToSnake(domain);
  const toToml = registry.getSection(domain)?.toToml;

  if (value === undefined) {
    delete rawSnake[snakeKey];
    return;
  }

  if (toToml !== undefined) {
    const rawSub = cloneRecord(rawSnake[snakeKey]);
    const converted = toToml(value, rawSub);
    if (converted === undefined || converted === null) {
      delete rawSnake[snakeKey];
    } else if (isPlainObject(converted) && Object.keys(converted).length === 0) {
      delete rawSnake[snakeKey];
    } else {
      rawSnake[snakeKey] = converted;
    }
    return;
  }

  if (!isPlainObject(value)) {
    setDefined(rawSnake, snakeKey, value);
    return;
  }
  const rawSub = cloneRecord(rawSnake[snakeKey]);
  const converted = plainObjectToToml(value, rawSub);
  if (Object.keys(converted).length > 0) {
    rawSnake[snakeKey] = converted;
  } else {
    delete rawSnake[snakeKey];
  }
}

export function describeTomlSyntaxError(error: unknown): string {
  const firstLine = describeUnknownError(error).split('\n', 1)[0] ?? '';
  if (error instanceof TomlError) {
    return `${firstLine} (line ${error.line}, column ${error.column})`;
  }
  return firstLine;
}

export function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return cloneUnknown(value);
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function setDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  } else {
    delete target[key];
  }
}
