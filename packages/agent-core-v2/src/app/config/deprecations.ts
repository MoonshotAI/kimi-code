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

function subtreeHasModelName(entry: Record<string, unknown>): boolean {
  if (hasModelNameKey(entry)) return true;
  return childTables(entry).some(([, value]) => subtreeHasModelName(value));
}

function tomlBasicString(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    } else out += ch;
  }
  return out;
}

function hasSchemaSettingsChild(entry: Record<string, unknown>): boolean {
  return Object.entries(entry).some(
    ([key, value]) =>
      SCHEMA_CHILD_KEYS.has(key) && isPlainObject(value) && !isModelShaped(value),
  );
}

function nestedModelDiagnostic(path: readonly string[]): ConfigDiagnostic {
  const full = path.join('.');
  return {
    domain: 'models',
    severity: 'warning',
    message:
      `[models] entry '${tomlBasicString(full)}' is nested under '${tomlBasicString(path[0]!)}' and cannot be used as a model; ` +
      `if the alias contains dots, quote the table name (e.g. [models."${tomlBasicString(full)}"]).`,
  };
}

function missingNameDiagnostic(path: readonly string[]): ConfigDiagnostic {
  const full = path.join('.');
  const remedy =
    path.length === 1
      ? `add a nonblank 'model' (or 'name') field to make it usable.`
      : `add a nonblank 'model' (or 'name') field, and quote the table name if the alias contains dots (e.g. [models."${tomlBasicString(full)}"]).`;
  return {
    domain: 'models',
    severity: 'warning',
    message:
      `[models] entry '${tomlBasicString(full)}' has no usable model name and cannot be used as a model; ` +
      remedy,
  };
}

function walkModelEntry(
  path: readonly string[],
  entry: Record<string, unknown>,
  diagnostics: ConfigDiagnostic[],
): void {
  const usable = isModelShaped(entry);
  const before = diagnostics.length;
  for (const [key, value] of childTables(entry)) {
    const childPath = [...path, key];
    if (SCHEMA_CHILD_KEYS.has(key)) {
      if (isModelShaped(value)) {
        diagnostics.push(nestedModelDiagnostic(childPath));
        walkModelEntry(childPath, value, diagnostics);
      } else if (subtreeHasModelName(value)) {
        walkModelEntry(childPath, value, diagnostics);
      }
      continue;
    }
    if (usable) {
      if (!subtreeHasModelName(value)) continue;
      if (isModelShaped(value)) {
        diagnostics.push(nestedModelDiagnostic(childPath));
      } else if (hasModelNameKey(value)) {
        diagnostics.push(missingNameDiagnostic(childPath));
      }
      walkModelEntry(childPath, value, diagnostics);
      continue;
    }
    if (isModelShaped(value)) {
      diagnostics.push(nestedModelDiagnostic(childPath));
    } else if (
      hasModelNameKey(value) ||
      hasModelRecordField(value) ||
      hasSchemaSettingsChild(value) ||
      childTables(value).length === 0
    ) {
      diagnostics.push(missingNameDiagnostic(childPath));
    }
    walkModelEntry(childPath, value, diagnostics);
  }
  if (
    path.length === 1 &&
    !usable &&
    (hasModelNameKey(entry) ||
      hasModelRecordField(entry) ||
      hasSchemaSettingsChild(entry) ||
      diagnostics.length === before)
  ) {
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
