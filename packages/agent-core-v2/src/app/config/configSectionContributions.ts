import { collection } from '#/_base/di/collection';
import type { ConfigSchema, RegisterSectionOptions } from './config';

export interface ConfigSectionContribution {
  readonly domain: string;
  readonly schema: ConfigSchema<unknown>;
  readonly options: RegisterSectionOptions<unknown>;
}

export const ConfigSectionContribution = collection<ConfigSectionContribution>('config-section');

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
