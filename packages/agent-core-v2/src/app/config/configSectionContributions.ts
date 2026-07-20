/**
 * `config` domain (L2) — module-level config-section contribution collector.
 *
 * Lets each owning domain self-register its config section at module load time
 * ("import = register"), mirroring the `_scopedRegistry` pattern used for
 * scoped services. An owner `configSection.ts` calls `registerConfigSection(...)`
 * at the top level; `ConfigRegistry` drains the collected contributions when it
 * is constructed. Pure data — no DI, no container — so `config` never imports
 * any owner domain, and a section becomes available as soon as its domain barrel
 * is imported, regardless of whether the consuming Service is instantiated.
 */

import type { ConfigSchema, RegisterSectionOptions } from './config';

export interface ConfigSectionContribution {
  readonly domain: string;
  readonly schema: ConfigSchema<unknown>;
  readonly options: RegisterSectionOptions<unknown>;
}

const _contributions: ConfigSectionContribution[] = [];

export function registerConfigSection<T>(
  domain: string,
  schema: ConfigSchema<T>,
  options: RegisterSectionOptions<T> = {},
): void {
  _contributions.push({
    domain,
    schema: schema as ConfigSchema<unknown>,
    options: options as RegisterSectionOptions<unknown>,
  });
}

export function getConfigSectionContributions(): readonly ConfigSectionContribution[] {
  return _contributions;
}

export function _clearConfigSectionContributionsForTests(): void {
  _contributions.length = 0;
}
