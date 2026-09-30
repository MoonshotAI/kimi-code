import { parse as parseToml, stringify as stringifyToml, TomlError } from 'smol-toml';

import { describeUnknownError, isPlainObject } from './pure';

export interface ConfigTomlHooks {
  readonly fromToml?: (raw: unknown) => unknown;
  readonly toToml?: (value: unknown, raw: unknown) => unknown;
}

export type ConfigTomlSectionLookup = (name: string) => ConfigTomlHooks | undefined;

export function parseConfigText(text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {};
  const data: unknown = parseToml(text);
  if (!isPlainObject(data)) {
    throw new Error('config root must be a TOML table');
  }
  return data;
}

export function serializeConfig(data: Record<string, unknown>): string {
  if (Object.keys(data).length === 0) return '';
  return stringifyToml(data);
}

export function describeTomlSyntaxError(error: unknown): string {
  const firstLine = describeUnknownError(error).split('\n', 1)[0] ?? '';
  if (error instanceof TomlError) {
    return `${firstLine} (line ${error.line}, column ${error.column})`;
  }
  return firstLine;
}

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

export function defaultFromToml(value: unknown): unknown {
  return isPlainObject(value) ? transformPlainObject(value) : value;
}

export function transformTomlData(
  data: Record<string, unknown>,
  lookup: ConfigTomlSectionLookup,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const name = snakeToCamel(key);
    const fromToml = lookup(name)?.fromToml;
    result[name] = fromToml === undefined ? defaultFromToml(value) : fromToml(value);
  }
  return result;
}

export function applySectionToToml(
  rawSnake: Record<string, unknown>,
  name: string,
  value: unknown,
  lookup: ConfigTomlSectionLookup,
): void {
  const snakeKey = camelToSnake(name);
  const toToml = lookup(name)?.toToml;

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
