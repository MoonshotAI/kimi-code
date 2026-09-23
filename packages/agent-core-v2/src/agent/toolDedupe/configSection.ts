import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import {
  type ConfigStripEnv,
  type EnvBindings,
  envBindings,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const REPEAT_BREAKER_SECTION = 'repeatBreaker';
export const RepeatBreakerConfigSchema = z.boolean().optional();
export type RepeatBreakerConfig = z.infer<typeof RepeatBreakerConfigSchema>;

export const REPEAT_BREAKER_ENV = 'KIMI_CODE_REPEAT_BREAKER';

export const repeatBreakerEnvBindings: EnvBindings<RepeatBreakerConfig> = envBindings(
  RepeatBreakerConfigSchema,
  {
    env: REPEAT_BREAKER_ENV,
    parse: parseBooleanEnv,
  },
);

export const stripRepeatBreakerEnv: ConfigStripEnv<RepeatBreakerConfig> = (value, raw, getEnv) => {
  if (getEnv === undefined) return value;
  if (parseBooleanEnv(getEnv(REPEAT_BREAKER_ENV)) === undefined) return value;
  return typeof raw === 'boolean' ? raw : undefined;
};

registerConfigSection(REPEAT_BREAKER_SECTION, RepeatBreakerConfigSchema, {
  defaultValue: true,
  env: repeatBreakerEnvBindings,
  stripEnv: stripRepeatBreakerEnv,
});

export function repeatBreakerEnabled(config: IConfigService): boolean {
  return config.get<RepeatBreakerConfig>(REPEAT_BREAKER_SECTION) !== false;
}

export const TOOL_DEDUPE_SECTION = 'toolDedupe';
export const ToolDedupeConfigSchema = z.boolean().optional();
export type ToolDedupeConfig = z.infer<typeof ToolDedupeConfigSchema>;

export const TOOL_DEDUPE_ENV = 'KIMI_CODE_TOOL_DEDUPE';

export const toolDedupeEnvBindings: EnvBindings<ToolDedupeConfig> = envBindings(
  ToolDedupeConfigSchema,
  {
    env: TOOL_DEDUPE_ENV,
    parse: parseBooleanEnv,
  },
);

export const stripToolDedupeEnv: ConfigStripEnv<ToolDedupeConfig> = (value, raw, getEnv) => {
  if (getEnv === undefined) return value;
  if (parseBooleanEnv(getEnv(TOOL_DEDUPE_ENV)) === undefined) return value;
  return typeof raw === 'boolean' ? raw : undefined;
};

registerConfigSection(TOOL_DEDUPE_SECTION, ToolDedupeConfigSchema, {
  defaultValue: true,
  env: toolDedupeEnvBindings,
  stripEnv: stripToolDedupeEnv,
});

export function toolDedupeEnabled(config: IConfigService): boolean {
  return config.get<ToolDedupeConfig>(TOOL_DEDUPE_SECTION) !== false;
}
