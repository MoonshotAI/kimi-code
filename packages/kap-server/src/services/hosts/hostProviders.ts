import { IConfigService, IKosongConfigService, type ModelRecord, type ProviderConfig, type Scope } from '@moonshot-ai/agent-core-v2';
import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  ModelsSectionSchema,
  PROVIDERS_SECTION,
  ProvidersSectionSchema,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import { ErrorCode } from '../../protocol/error-codes';
import type { HostSession } from './hostSession';

export const providerSkipReasonSchema = z.enum(['exists', 'oauth', 'env_key', 'loopback']);

export type ProviderSkipReason = z.infer<typeof providerSkipReasonSchema>;

export const skippedProviderSchema = z.object({ id: z.string(), reason: providerSkipReasonSchema });

export interface SkippedProvider {
  readonly id: string;
  readonly reason: ProviderSkipReason;
}

const sharedProvidersSchema = z.object({
  providers: ProvidersSectionSchema,
  models: ModelsSectionSchema,
}).strict();

export type SharedProviders = z.infer<typeof sharedProvidersSchema>;

export interface ProviderCopyResult {
  readonly copied: readonly string[];
  readonly updated: readonly string[];
  readonly skipped: readonly SkippedProvider[];
}

const providerCopyResultSchema = z.object({
  copied: z.array(z.string()),
  updated: z.array(z.string()).default([]),
  skipped: z.array(skippedProviderSchema),
});

const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '[::1]', '[::]']);

function loopback(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function skipReason(provider: ProviderConfig): ProviderSkipReason | undefined {
  if (provider.oauth !== undefined) return 'oauth';
  if ((provider.apiKey ?? '') === '' && (provider.apiKeyEnv ?? '') !== '') return 'env_key';
  if (loopback(provider.baseUrl)) return 'loopback';
  return undefined;
}

export async function collectSharedProviders(
  core: Scope,
  only?: readonly string[],
): Promise<{ readonly shared: SharedProviders; readonly skipped: SkippedProvider[] }> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const providers = config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
  const models = config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
  const shared: SharedProviders = { providers: {}, models: {} };
  const skipped: SkippedProvider[] = [];
  const selected = only === undefined ? undefined : new Set(only);
  for (const [id, provider] of Object.entries(providers)) {
    if (id.startsWith('managed:')) continue;
    if (selected !== undefined && !selected.has(id)) continue;
    const reason = skipReason(provider);
    if (reason !== undefined) {
      skipped.push({ id, reason });
      continue;
    }
    shared.providers[id] = structuredClone(provider);
  }
  for (const [alias, model] of Object.entries(models)) {
    if (model.provider !== undefined && shared.providers[model.provider] !== undefined) {
      shared.models[alias] = structuredClone(model);
    }
  }
  return { shared, skipped };
}

let importChain: Promise<unknown> = Promise.resolve();

export function importSharedProviders(core: Scope, input: unknown): Promise<ProviderCopyResult> {
  const run = importChain.then(async () => {
    const incoming = sharedProvidersSchema.parse(input);
    const config = core.accessor.get(IConfigService);
    await config.ready;
    await core.accessor.get(IKosongConfigService).ready;
    const providers = config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const models = config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const copied: string[] = [];
    const updated: string[] = [];
    for (const id of Object.keys(incoming.providers)) {
      if (providers[id] === undefined) copied.push(id);
      else updated.push(id);
    }
    const incomingAliases = Object.keys(incoming.models);
    if (copied.length + updated.length > 0) await config.replace(PROVIDERS_SECTION, { ...providers, ...incoming.providers });
    if (incomingAliases.length > 0) await config.replace(MODELS_SECTION, { ...models, ...incoming.models });
    const currentDefault = config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const firstAlias = incomingAliases[0];
    if ((currentDefault === undefined || currentDefault.trim() === '') && firstAlias !== undefined) {
      await config.replace(DEFAULT_MODEL_SECTION, firstAlias);
    }
    return { copied, updated, skipped: [] };
  });
  importChain = run.catch(() => undefined);
  return run;
}

export async function sendSharedProviders(session: HostSession, shared: SharedProviders): Promise<ProviderCopyResult> {
  const response = await session.request({
    method: 'POST',
    path: '/api/v1/hosts:import-providers',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(shared)),
    timeoutMs: 60_000,
  });
  const body = JSON.parse(response.body.toString('utf8')) as { code?: number; msg?: string; data?: unknown };
  if (response.status !== 200 || body.code !== 0 || body.data === undefined) {
    throw new Error(body.msg ?? 'Unable to copy model providers to the SSH host');
  }
  return providerCopyResultSchema.parse(body.data);
}

export function registerImportProvidersRoute(app: {
  post(path: string, options: { schema?: Record<string, unknown> }, handler: never): unknown;
}, core: Scope): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/hosts::import-providers',
      success: { data: providerCopyResultSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Add model providers copied from the connecting computer; providers with the same name here are replaced',
      tags: ['hosts'],
    },
    async (req: { body: unknown; id: string }, reply: { send(payload: unknown): void }) => {
      try {
        reply.send(okEnvelope(await importSharedProviders(core, req.body), req.id));
      } catch (error) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.post(route.path, route.options, route.handler as never);
}
