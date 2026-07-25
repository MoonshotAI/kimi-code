/**
 * `providerService` — provider configuration registry. Mirrors
 * `agent-core-v2/kosong/provider/provider.ts` (`ProviderConfigSchema`).
 * `type` is free-form text, not an enum: vendor identity is validated at
 * resolve time against the engine's provider-definition registry, so external
 * packages can register new vendors without touching this schema.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const providerTypeSchema = z.string();

const oAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

const stringRecordSchema = z.record(z.string(), z.string());

const modelSourceSchema = z.enum(['static', 'discover', 'oauth-catalog']);

export const providerConfigSchema = z.object({
  modelSource: modelSourceSchema.optional(),

  baseUrl: z.string().optional(),
  customHeaders: stringRecordSchema.optional(),
  defaultModel: z.string().optional(),

  type: providerTypeSchema.optional(),
  apiKey: z.string().optional(),
  oauth: oAuthRefSchema.optional(),
  env: stringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export const providersContract = {
  get: { input: z.tuple([z.string()]), output: maybe(providerConfigSchema) },
  list: { input: z.tuple([]), output: z.record(z.string(), providerConfigSchema) },
  set: { input: z.tuple([z.string(), providerConfigSchema]), output: noResult },
  delete: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;
