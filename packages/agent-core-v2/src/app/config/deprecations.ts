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

const MODEL_RECORD_KEYS = new Set([
  'provider',
  'provider_id',
  'base_url',
  'api_key',
  'protocol',
  'max_context_size',
  'max_input_size',
  'max_output_size',
  'capabilities',
  'display_name',
  'reasoning_key',
  'adaptive_thinking',
  'beta_api',
  'support_efforts',
  'default_effort',
  'off_effort',
  'aliases',
]);

function hasModelNameKey(entry: Record<string, unknown>): boolean {
  return entry['model'] !== undefined || entry['name'] !== undefined;
}

function hasModelRecordField(entry: Record<string, unknown>): boolean {
  return Object.keys(entry).some((key) => MODEL_RECORD_KEYS.has(key));
}

function childTables(entry: Record<string, unknown>): [string, Record<string, unknown>][] {
  return Object.entries(entry).filter(
    (pair): pair is [string, Record<string, unknown>] => isPlainObject(pair[1]),
  );
}

function subtreeHasAliasEvidence(entry: Record<string, unknown>): boolean {
  if (hasModelNameKey(entry) || hasModelRecordField(entry)) return true;
  return childTables(entry).some(([, value]) => subtreeHasAliasEvidence(value));
}

function nestedModelDiagnostic(path: readonly string[]): ConfigDiagnostic {
  const full = path.join('.');
  return {
    domain: 'models',
    severity: 'warning',
    message:
      `[models] entry '${full}' is nested under '${path[0]}' and cannot be used as a model; ` +
      `if the alias contains dots, quote the table name (e.g. [models."${full}"]).`,
  };
}

function missingNameDiagnostic(path: readonly string[]): ConfigDiagnostic {
  const full = path.join('.');
  return {
    domain: 'models',
    severity: 'warning',
    message:
      `[models] entry '${full}' has no usable model name and cannot be used as a model; ` +
      `if the alias contains dots, quote the table name (e.g. [models."${full}"]).`,
  };
}

function walkModelEntry(
  path: readonly string[],
  entry: Record<string, unknown>,
  diagnostics: ConfigDiagnostic[],
): void {
  let emitted = 0;
  for (const [key, value] of childTables(entry)) {
    const childPath = [...path, key];
    if (SCHEMA_CHILD_KEYS.has(key)) {
      if (!isModelShaped(value)) continue;
      diagnostics.push(nestedModelDiagnostic(childPath));
      emitted++;
      walkModelEntry(childPath, value, diagnostics);
      continue;
    }
    if (!subtreeHasAliasEvidence(value)) continue;
    if (isModelShaped(value)) {
      diagnostics.push(nestedModelDiagnostic(childPath));
      emitted++;
    } else if (hasModelNameKey(value) || hasModelRecordField(value)) {
      diagnostics.push(missingNameDiagnostic(childPath));
      emitted++;
    }
    walkModelEntry(childPath, value, diagnostics);
  }
  if (path.length === 1 && !isModelShaped(entry) && emitted === 0) {
    diagnostics.push(missingNameDiagnostic(path));
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
