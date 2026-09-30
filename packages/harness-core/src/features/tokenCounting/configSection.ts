import { z } from 'zod';

import type { ConfigSectionContribution, EnvBindings } from '@moonshot-ai/agent-core';

import { stripEnvBoundFields } from '#/config-env';

import type { TokenCountingStrategy } from './tokenCounting';

export const TOKEN_COUNTING_SECTION = 'tokenCounting';

export const TOKEN_COUNTING_STRATEGY_ENV = 'KIMI_TOKEN_COUNTING_STRATEGY';

export const TOKEN_COUNTING_STRATEGIES = ['measured+estimated', 'measured', 'estimated'] as const;

const tokenCountingConfigSchema = z.object({
  strategy: z.enum(TOKEN_COUNTING_STRATEGIES),
});

export type TokenCountingConfig = z.infer<typeof tokenCountingConfigSchema>;

export const DEFAULT_TOKEN_COUNTING_CONFIG: TokenCountingConfig = {
  strategy: 'measured+estimated',
};

function parseStrategy(raw: string): TokenCountingStrategy | undefined {
  const value = raw.trim().toLowerCase();
  return (TOKEN_COUNTING_STRATEGIES as readonly string[]).includes(value)
    ? (value as TokenCountingStrategy)
    : undefined;
}

const tokenCountingEnvBindings: EnvBindings<TokenCountingConfig> = {
  strategy: { env: TOKEN_COUNTING_STRATEGY_ENV, parse: parseStrategy },
};

export const tokenCountingConfigSection: ConfigSectionContribution<TokenCountingConfig> = {
  name: TOKEN_COUNTING_SECTION,
  schema: tokenCountingConfigSchema,
  defaultValue: DEFAULT_TOKEN_COUNTING_CONFIG,
  envBindings: tokenCountingEnvBindings,
  stripEnv: stripEnvBoundFields<TokenCountingConfig>(tokenCountingEnvBindings),
};
