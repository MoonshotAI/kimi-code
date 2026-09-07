import type { ConfigDiagnostic, ConfigSection } from './config';
import { isPlainObject } from './configPure';
import { camelToSnake } from './toml';

export function collectMalformedModelEntries(
  rawSnake: Record<string, unknown>,
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const rawSection = rawSnake['models'];
  if (!isPlainObject(rawSection)) return diagnostics;
  for (const [alias, entry] of Object.entries(rawSection)) {
    if (!isPlainObject(entry)) continue;
    if (entry['model'] !== undefined || entry['name'] !== undefined) continue;
    diagnostics.push({
      domain: 'models',
      severity: 'warning',
      message:
        `[models] entry '${alias}' is missing the 'model' field and cannot be used as a model; ` +
        `if the alias contains dots, quote the table name (e.g. [models."${alias}"]).`,
    });
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
