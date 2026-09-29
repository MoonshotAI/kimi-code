import { z } from 'zod';

import type { ConfigSectionContribution } from '@moonshot-ai/agent-core';

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

export const tokenCountingConfigSection: ConfigSectionContribution<TokenCountingConfig> = {
  name: TOKEN_COUNTING_SECTION,
  schema: tokenCountingConfigSchema,
  defaultValue: DEFAULT_TOKEN_COUNTING_CONFIG,
  envBindings: {
    strategy: { env: TOKEN_COUNTING_STRATEGY_ENV, parse: parseStrategy },
  },
  stripEnv: () => undefined,
};
