import { parse as parseToml, stringify as stringifyToml, TomlError } from 'smol-toml';

import { describeUnknownError, isPlainObject } from './pure';

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
