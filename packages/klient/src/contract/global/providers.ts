/**
 * `providerService` — provider configuration registry. Mirrors
 * `agent-core-v2/app/provider/provider.ts` (`ProviderConfigSchema`).
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const providerTypeSchema = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
]);

const oAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

const stringRecordSchema = z.record(z.string(), z.string());

type JSONValue = string | number | boolean | null | JSONValue[] | JSONObject;
interface JSONObject {
  [key: string]: JSONValue;
}

const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
function hasUnsafeCustomBodyKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeCustomBodyKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, entryValue]) =>
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor' ||
      hasUnsafeCustomBodyKey(entryValue),
  );
}

const customBodySchema: z.ZodType<JSONObject> = z
  .unknown()
  .superRefine((value, ctx) => {
    if (hasUnsafeCustomBodyKey(value)) {
      ctx.addIssue({ code: 'custom', message: 'customBody cannot contain unsafe object keys' });
    }
  })
  .pipe(z.record(z.string(), jsonValueSchema));

const modelSourceSchema = z.enum(['static', 'discover', 'oauth-catalog']);

export const providerConfigSchema = z.object({
  platformId: z.string().optional(),
  modelSource: modelSourceSchema.optional(),

  baseUrl: z.string().optional(),
  customHeaders: stringRecordSchema.optional(),
  customBody: customBodySchema.optional(),
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
