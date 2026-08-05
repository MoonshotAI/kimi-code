/**
 * `config` domain — declarative config-key deprecation detection.
 *
 * A section declares its renames once (`RegisterSectionOptions.deprecations`,
 * snake_case keys as written on disk) and this module turns the presence of a
 * deprecated key in the on-disk document into a warning `ConfigDiagnostic`.
 * Detection is read-only: the old value is never mapped onto the new key (the
 * section schema no longer knows the old key, so it is dropped at validation),
 * and the user's file is left untouched — the warning is the migration guide.
 */

import type { ConfigDiagnostic, ConfigSection } from './config';
import { isPlainObject } from './configPure';
import { camelToSnake } from './toml';

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
