import { z } from 'zod';

import { maybe } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const betaMasterSwitchStateSchema = z.object({
  enabled: z.boolean(),
  source: z.enum(['env', 'config', 'default']),
  env: z.string(),
  configValue: z.boolean().optional(),
});

export const experimentalFeatureStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  stage: z.enum(['experimental', 'beta', 'ga']),
  effectTiming: z.enum(['immediate', 'next-session', 'restart']),
  env: z.string(),
  enabled: z.boolean(),
  active: z.boolean(),
  source: z.enum(['env', 'master-env', 'beta-config', 'config', 'default']),
  configValue: z.boolean().optional(),
});

export const flagsContract = {
  betaState: { input: z.tuple([]), output: betaMasterSwitchStateSchema },
  enabled: { input: z.tuple([z.string()]), output: z.boolean() },
  snapshot: { input: z.tuple([]), output: z.record(z.string(), z.boolean()) },
  enabledIds: { input: z.tuple([]), output: z.array(z.string()) },
  explain: { input: z.tuple([z.string()]), output: maybe(experimentalFeatureStateSchema) },
  explainAll: { input: z.tuple([]), output: z.array(experimentalFeatureStateSchema) },
} satisfies ServiceContract;
