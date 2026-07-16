/**
 * `configService` — layered global config service. Mirrors
 * `agent-core-v2/app/config/config.ts`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const configTargetSchema = z.enum(['user', 'memory']);

export const configInspectValueSchema = z.object({
  value: z.unknown().optional(),
  defaultValue: z.unknown().optional(),
  userValue: z.unknown().optional(),
  memoryValue: z.unknown().optional(),
});

export const configDiagnosticSchema = z.object({
  domain: z.string().optional(),
  severity: z.enum(['warning', 'error']),
  message: z.string(),
});

export const configContract = {
  get: { input: z.tuple([z.string()]), output: z.unknown() },
  inspect: { input: z.tuple([z.string()]), output: configInspectValueSchema },
  getAll: { input: z.tuple([]), output: z.record(z.string(), z.unknown()) },
  set: {
    input: z.tuple([z.string(), z.unknown(), configTargetSchema.optional()]),
    output: noResult,
  },
  replace: {
    input: z.tuple([z.string(), z.unknown(), configTargetSchema.optional()]),
    output: noResult,
  },
  reload: { input: z.tuple([]), output: noResult },
  diagnostics: { input: z.tuple([]), output: z.array(configDiagnosticSchema) },
} satisfies ServiceContract;
