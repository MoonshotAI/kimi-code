import type { ConfigDiagnostic, ConfigSection } from './config';
import { isPlainObject } from './configPure';
import { camelToSnake } from './toml';

function isUsableName(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isModelShaped(entry: Record<string, unknown>): boolean {
  return isUsableName(entry['name'] ?? entry['model']);
}

const SCHEMA_CHILD_KEYS = new Set(['overrides', 'oauth']);

function childTables(entry: Record<string, unknown>): [string, Record<string, unknown>][] {
  return Object.entries(entry).filter(
    (pair): pair is [string, Record<string, unknown>] =>
      isPlainObject(pair[1]) && !SCHEMA_CHILD_KEYS.has(pair[0]),
  );
}

function walkModelEntry(
  path: readonly string[],
  entry: Record<string, unknown>,
  diagnostics: ConfigDiagnostic[],
): void {
  const children = childTables(entry);
  if (!isModelShaped(entry) && children.length === 0) {
    const full = path.join('.');
    diagnostics.push({
      domain: 'models',
      severity: 'warning',
      message:
        `[models] entry '${full}' has no usable model name and cannot be used as a model; ` +
        `if the alias contains dots, quote the table name (e.g. [models."${full}"]).`,
    });
    return;
  }
  if (path.length > 1 && isModelShaped(entry)) {
    const full = path.join('.');
    diagnostics.push({
      domain: 'models',
      severity: 'warning',
      message:
        `[models] entry '${full}' is nested under '${path[0]}' and cannot be used as a model; ` +
        `if the alias contains dots, quote the table name (e.g. [models."${full}"]).`,
    });
  }
  for (const [key, value] of children) {
    walkModelEntry([...path, key], value, diagnostics);
  }
}

export function collectMalformedModelEntries(
  rawSnake: Record<string, unknown>,
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const rawSection = rawSnake['models'];
  if (!isPlainObject(rawSection)) return diagnostics;
  for (const [alias, entry] of Object.entries(rawSection)) {
    if (!isPlainObject(entry)) continue;
    walkModelEntry([alias], entry, diagnostics);
  }
  return diagnostics;
}

export function collectKeyDeprecations(
  rawSnake: Record<string, unknown>,
  sections: readonly ConfigSection[],
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  for (const section of sections) {
    const deprecations = section.deprecations;
    if (deprecations === undefined || deprecations.length === 0) continue;
    const snakeDomain = camelToSnake(section.domain);
    const rawSection = rawSnake[snakeDomain];
    if (!isPlainObject(rawSection)) continue;
    for (const deprecation of deprecations) {
      if (rawSection[deprecation.key] === undefined) continue;
      diagnostics.push({
        domain: section.domain,
        severity: 'warning',
        message:
          `[${snakeDomain}] '${deprecation.key}' is deprecated and no longer used; ` +
          `rename it to '${deprecation.replacement}'.` +
          (deprecation.message === undefined ? '' : ` ${deprecation.message}`) +
          ' Run /update-config to fix it.',
      });
    }
  }
  return diagnostics;
}
