/**
 * `modelService` — model configuration registry. Mirrors
 * `agent-core-v2/kosong/model/model.ts` (`ModelRecordSchema`, including its
 * passthrough of unknown keys) and `agent-core-v2/kosong/protocol/protocol.ts`
 * (`ProtocolSchema` — the four real wire protocols; `kimi` is a provider
 * `type`, not a protocol, and Vertex AI is a `providerOptions` mode of
 * `google-genai`). The schema name stays `modelConfigSchema` while the
 * engine type is `ModelRecord` — the contract-parity test pins that pairing.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const protocolSchema = z.enum([
  'anthropic',
  'openai',
  'openai_responses',
  'google-genai',
]);

const oAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

const modelBaseSchema = z.object({
  providerId: z.string().optional(),

  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: oAuthRefSchema.optional(),

  protocol: protocolSchema.optional(),

  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),

  provider: z.string().optional(),
  model: z.string().optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  betaApi: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
});

const modelOverrideSchema = modelBaseSchema
  .omit({
    providerId: true,
    baseUrl: true,
    apiKey: true,
    oauth: true,
    protocol: true,
    name: true,
    aliases: true,
    provider: true,
    model: true,
    betaApi: true,
  })
  .partial();

export const modelConfigSchema = modelBaseSchema
  .extend({ overrides: modelOverrideSchema.optional() })
  .passthrough();

export const modelsContract = {
  get: { input: z.tuple([z.string()]), output: maybe(modelConfigSchema) },
  list: { input: z.tuple([]), output: z.record(z.string(), modelConfigSchema) },
  set: { input: z.tuple([z.string(), modelConfigSchema]), output: noResult },
  delete: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;
