/**
 * `flagService` — experimental-flag resolution. Mirrors
 * `agent-core-v2/app/flag/flag.ts`. The `registry` property and
 * `setConfigOverrides` are excluded (not part of the read-only wire surface).
 */

import { z } from 'zod';

import { maybe } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const experimentalFeatureStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  surface: z.enum(['core', 'tui', 'both']),
  env: z.string(),
  defaultEnabled: z.boolean(),
  enabled: z.boolean(),
  source: z.enum(['master-env', 'env', 'config', 'default']),
  configValue: z.boolean().optional(),
});

export const flagsContract = {
  enabled: { input: z.tuple([z.string()]), output: z.boolean() },
  snapshot: { input: z.tuple([]), output: z.record(z.string(), z.boolean()) },
  enabledIds: { input: z.tuple([]), output: z.array(z.string()) },
  explain: { input: z.tuple([z.string()]), output: maybe(experimentalFeatureStateSchema) },
  explainAll: { input: z.tuple([]), output: z.array(experimentalFeatureStateSchema) },
} satisfies ServiceContract;
