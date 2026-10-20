import { z } from 'zod';

import type { ConfigSectionContribution } from '#/features/config/index';

import { visibleBuiltinSkills } from '../builtin/definitions';

import {
  BUILTIN_SKILL_SOURCE_ID,
  SKILL_SOURCE_PRIORITY,
  type SkillCatalogSource,
  type SkillContribution,
} from './source';

export const BUILTIN_PRODUCT_SKILLS_SECTION = 'builtinProductSkills';

export const BUILTIN_PRODUCT_SKILLS_ENV = 'KIMI_CODE_BUILTIN_PRODUCT_SKILLS';

const EXPERIMENTAL_MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

const TRUE_BOOLEAN_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

export const builtinProductSkillsSection: ConfigSectionContribution<boolean> = {
  name: BUILTIN_PRODUCT_SKILLS_SECTION,
  schema: z.boolean(),
  defaultValue: true,
  envBindings: {
    env: BUILTIN_PRODUCT_SKILLS_ENV,
    parse: parseBooleanEnv,
  },
  stripEnv: (value, raw, getEnv) => {
    if (parseBooleanEnv(getEnv(BUILTIN_PRODUCT_SKILLS_ENV)) === undefined) return value;
    return typeof raw === 'boolean' ? raw : undefined;
  },
};

export function experimentalFlagEnabled(flag: string): boolean {
  return (
    envFlagEnabled(`KIMI_CODE_EXPERIMENTAL_${flag.toUpperCase().replaceAll('-', '_')}`) ||
    envFlagEnabled(EXPERIMENTAL_MASTER_ENV)
  );
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  return value === 'true' || value === '1';
}

export function createBuiltinSkillSource(deps: {
  readonly productSkillsEnabled: () => boolean;
}): SkillCatalogSource {
  return {
    id: BUILTIN_SKILL_SOURCE_ID,
    priority: SKILL_SOURCE_PRIORITY.builtin,
    load: (): Promise<SkillContribution> =>
      Promise.resolve({
        skills: visibleBuiltinSkills(deps.productSkillsEnabled(), experimentalFlagEnabled),
      }),
  };
}
