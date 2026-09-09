import type { ConfigDiagnostic } from './config';
import { isPlainObject } from './configPure';

const MODELS_DOMAIN = 'models';
const KNOWN_OBJECT_FIELDS = new Set(['oauth', 'overrides']);

export function collectMalformedModelEntries(
  rawSnake: Record<string, unknown>,
): ConfigDiagnostic[] {
  const rawModels = rawSnake[MODELS_DOMAIN];
  if (!isPlainObject(rawModels)) return [];
  const diagnostics: ConfigDiagnostic[] = [];
  for (const [alias, entry] of Object.entries(rawModels)) {
    if (!isPlainObject(entry)) continue;
    if (entry['model'] !== undefined || entry['name'] !== undefined) continue;
    diagnostics.push({
      domain: MODELS_DOMAIN,
      severity: 'warning',
      message: malformedModelMessage(alias, entry),
    });
  }
  return diagnostics;
}

function malformedModelMessage(alias: string, entry: Record<string, unknown>): string {
  const base = `[models] entry '${alias}' is missing the 'model' field and cannot be used as a model`;
  const dottedAlias = dottedAliasSuffix(alias, entry);
  if (dottedAlias === undefined) return `${base}.`;
  return `${base}; if the alias contains dots, quote the table name (e.g. [models."${dottedAlias}"]).`;
}

function dottedAliasSuffix(alias: string, entry: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(entry)) {
    if (KNOWN_OBJECT_FIELDS.has(key) || !isPlainObject(value)) continue;
    return dottedAliasSuffix(`${alias}.${key}`, value) ?? `${alias}.${key}`;
  }
  return undefined;
}
