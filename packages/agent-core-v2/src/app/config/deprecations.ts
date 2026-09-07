import type { ConfigDiagnostic, ConfigSection } from './config';
import { isPlainObject } from './configPure';
import { camelToSnake } from './toml';

function isUsableName(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isModelShaped(entry: Record<string, unknown>): boolean {
  return isUsableName(entry['model']) || isUsableName(entry['name']);
}

function collectNestedModelPaths(
  entry: Record<string, unknown>,
  path: readonly string[],
): (readonly string[])[] {
  const found: (readonly string[])[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (!isPlainObject(value)) continue;
    if (isModelShaped(value)) {
      found.push([...path, key]);
      continue;
    }
    found.push(...collectNestedModelPaths(value, [...path, key]));
  }
  return found;
}

function collectLeafPaths(
  entry: Record<string, unknown>,
  path: readonly string[],
): (readonly string[])[] {
  const children = Object.entries(entry).filter(([, value]) => isPlainObject(value));
  if (children.length === 0) return [path];
  return children.flatMap(([key, value]) =>
    collectLeafPaths(value as Record<string, unknown>, [...path, key]),
  );
}

export function collectMalformedModelEntries(
  rawSnake: Record<string, unknown>,
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const rawSection = rawSnake['models'];
  if (!isPlainObject(rawSection)) return diagnostics;
  for (const [alias, entry] of Object.entries(rawSection)) {
    if (!isPlainObject(entry)) continue;
    const nestedPaths = collectNestedModelPaths(entry, []);
    for (const nestedPath of nestedPaths) {
      const full = [alias, ...nestedPath].join('.');
      diagnostics.push({
        domain: 'models',
        severity: 'warning',
        message:
          `[models] entry '${full}' is nested under '${alias}' and cannot be used as a model; ` +
          `if the alias contains dots, quote the table name (e.g. [models."${full}"]).`,
      });
    }
    if (nestedPaths.length > 0 || isModelShaped(entry)) continue;
    for (const leafPath of collectLeafPaths(entry, [alias])) {
      const full = leafPath.join('.');
      diagnostics.push({
        domain: 'models',
        severity: 'warning',
        message:
          `[models] entry '${full}' is missing the 'model' field and cannot be used as a model; ` +
          `if the alias contains dots, quote the table name (e.g. [models."${full}"]).`,
      });
    }
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
