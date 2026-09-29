import { z } from 'zod';

import type { ConfigSectionContribution } from '@moonshot-ai/agent-core';

export const READ_CONFIG_SECTION = 'read';

export const ReadSectionSchema = z.object({
  defaultMaxChars: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
});

export type ReadSection = z.infer<typeof ReadSectionSchema>;

export const readConfigSection: ConfigSectionContribution<ReadSection> = {
  name: READ_CONFIG_SECTION,
  schema: ReadSectionSchema,
  defaultValue: {},
};

export const BASH_CONFIG_SECTION = 'bash';

export const BashSectionSchema = z.object({
  autoBackgroundOnTimeout: z.boolean().optional(),
  backgroundTaskTimeoutS: z.number().int().positive().optional(),
});

export type BashSection = z.infer<typeof BashSectionSchema>;

export const bashConfigSection: ConfigSectionContribution<BashSection> = {
  name: BASH_CONFIG_SECTION,
  schema: BashSectionSchema,
  defaultValue: {},
  envBindings: {
    backgroundTaskTimeoutS: {
      env: 'KIMI_CODE_BACKGROUND_BASH_TASK_TIMEOUT_S',
      parse: (raw) => {
        const value = Number(raw);
        return Number.isInteger(value) && value > 0 ? value : undefined;
      },
    },
  },
  stripEnv: (value) => {
    const out = { ...value };
    delete out.backgroundTaskTimeoutS;
    return out;
  },
};
