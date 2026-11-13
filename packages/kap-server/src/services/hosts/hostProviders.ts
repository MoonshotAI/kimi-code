import { IConfigService, IKosongConfigService, type ModelRecord, type ProviderConfig, type Scope } from '@moonshot-ai/agent-core-v2';
import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  ModelsSectionSchema,
  PROVIDERS_SECTION,
  ProvidersSectionSchema,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import { z } from 'zod';

import { okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import { ErrorCode } from '../../protocol/error-codes';
import type { HostSession } from './hostSession';

const sharedProvidersSchema = z.object({
  providers: ProvidersSectionSchema,
  models: ModelsSectionSchema,
}).strict();

export type SharedProviders = z.infer<typeof sharedProvidersSchema>;

export interface ProviderCopyResult {
  readonly copied: readonly string[];
  readonly updated: readonly string[];
}

export const providerCopyResultSchema = z.object({
  copied: z.array(z.string()),
  updated: z.array(z.string()).default([]),
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

function canShareProvider(provider: ProviderConfig): boolean {
  if (provider.oauth !== undefined) return false;
  if ((provider.apiKey ?? '') === '' && (provider.apiKeyEnv ?? '') !== '') return false;
  return !loopback(provider.baseUrl);
}

export async function collectSharedProviders(core: Scope): Promise<SharedProviders> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const providers = config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
  const models = config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
  const shared: SharedProviders = { providers: {}, models: {} };
  for (const [id, provider] of Object.entries(providers)) {
    if (id.startsWith('managed:') || !canShareProvider(provider)) continue;
    shared.providers[id] = structuredClone(provider);
  }
  for (const [alias, model] of Object.entries(models)) {
    if (model.provider !== undefined && shared.providers[model.provider] !== undefined) {
      shared.models[alias] = structuredClone(model);
    }
  }
  return shared;
}

let providerWrites: Promise<unknown> = Promise.resolve();

function queueProviderWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = providerWrites.then(write);
  providerWrites = run.catch(() => undefined);
  return run;
}

function importSharedProviders(core: Scope, incoming: SharedProviders): Promise<ProviderCopyResult> {
  return queueProviderWrite(async () => {
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
    const replaced = new Set(updated);
    const staleAliases = Object.entries(models)
      .filter(([alias, model]) => model.provider !== undefined && replaced.has(model.provider) && incoming.models[alias] === undefined)
      .map(([alias]) => alias);
    const kept = Object.fromEntries(Object.entries(models).filter(([alias]) => !staleAliases.includes(alias)));
    const incomingAliases = Object.keys(incoming.models);
    if (copied.length + updated.length > 0) await config.replace(PROVIDERS_SECTION, { ...providers, ...incoming.providers });
    if (incomingAliases.length + staleAliases.length > 0) await config.replace(MODELS_SECTION, { ...kept, ...incoming.models });
    const currentDefault = config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const firstAlias = incomingAliases[0];
    const defaultMissing = currentDefault === undefined || currentDefault.trim() === '' || staleAliases.includes(currentDefault);
    if (defaultMissing && firstAlias !== undefined) {
      await config.replace(DEFAULT_MODEL_SECTION, firstAlias);
    }
    return { copied, updated };
  });
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
  post(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: never): unknown;
}, core: Scope): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/hosts::import-providers',
      body: sharedProvidersSchema,
      success: { data: providerCopyResultSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Add model providers copied from the connecting computer; providers with the same name here are replaced along with their models',
      tags: ['hosts'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(await importSharedProviders(core, req.body), req.id));
    },
  );
  app.post(route.path, route.options, route.handler as never);
}
