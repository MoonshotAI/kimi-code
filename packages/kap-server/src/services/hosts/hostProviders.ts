import { createHash } from 'node:crypto';

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

export const providerSkipReasonSchema = z.enum(['oauth', 'env_key', 'loopback']);

export type ProviderSkipReason = z.infer<typeof providerSkipReasonSchema>;

export const skippedProviderSchema = z.object({ id: z.string(), reason: providerSkipReasonSchema });

export interface SkippedProvider {
  readonly id: string;
  readonly reason: ProviderSkipReason;
}

export const providerHostStatusSchema = z.enum(['missing', 'synced', 'outdated']);

export type ProviderHostStatus = z.infer<typeof providerHostStatusSchema>;

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

const providerDigestsBodySchema = z.object({ providers: z.array(z.string()) }).strict();

const providerDigestsSchema = z.object({ digests: z.record(z.string(), z.string()) });

const removeMatchingProvidersBodySchema = z.object({ providers: z.record(z.string(), z.string()) }).strict();

export const providerRemoveResultSchema = z.object({ removed: z.array(z.string()) });

export interface ProviderRemoveResult {
  readonly removed: readonly string[];
}

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

async function readProviderConfig(core: Scope): Promise<{
  readonly providers: Record<string, ProviderConfig>;
  readonly models: Record<string, ModelRecord>;
}> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  return {
    providers: config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {},
    models: config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {},
  };
}

export async function collectSharedProviders(
  core: Scope,
  only?: readonly string[],
): Promise<{ readonly shared: SharedProviders; readonly skipped: SkippedProvider[] }> {
  const { providers, models } = await readProviderConfig(core);
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => [key, canonical(record[key])]),
  );
}

function providerDigest(
  id: string,
  providers: Readonly<Record<string, ProviderConfig>>,
  models: Readonly<Record<string, ModelRecord>>,
): string | undefined {
  const provider = providers[id];
  if (provider === undefined) return undefined;
  const raw = {
    providers: { [id]: provider },
    models: Object.fromEntries(Object.entries(models).filter(([, model]) => model.provider === id)),
  };
  const parsed = sharedProvidersSchema.safeParse(raw);
  return createHash('sha256').update(JSON.stringify(canonical(parsed.success ? parsed.data : raw))).digest('hex');
}

function digestsOf(
  ids: readonly string[],
  providers: Readonly<Record<string, ProviderConfig>>,
  models: Readonly<Record<string, ModelRecord>>,
): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const id of ids) {
    const digest = providerDigest(id, providers, models);
    if (digest !== undefined) digests[id] = digest;
  }
  return digests;
}

export async function readProviderDigests(core: Scope, ids: readonly string[]): Promise<Record<string, string>> {
  const { providers, models } = await readProviderConfig(core);
  return digestsOf(ids, providers, models);
}

export function sharedProviderDigests(shared: SharedProviders): Record<string, string> {
  return digestsOf(Object.keys(shared.providers), shared.providers, shared.models);
}

export function compareProviderDigests(
  local: Readonly<Record<string, string>>,
  host: Readonly<Record<string, string>>,
): Record<string, ProviderHostStatus> {
  return Object.fromEntries(
    Object.entries(local).map(([id, digest]) => {
      const remote = host[id];
      return [id, remote === undefined ? 'missing' : remote === digest ? 'synced' : 'outdated'];
    }),
  );
}

let providerWrites: Promise<unknown> = Promise.resolve();

function queueProviderWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = providerWrites.then(write);
  providerWrites = run.catch(() => undefined);
  return run;
}

export function removeMatchingProviders(core: Scope, input: unknown): Promise<ProviderRemoveResult> {
  return queueProviderWrite(async () => {
    const expected = removeMatchingProvidersBodySchema.parse(input).providers;
    const config = core.accessor.get(IConfigService);
    await config.ready;
    await core.accessor.get(IKosongConfigService).ready;
    const providers = config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const models = config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const removed = Object.entries(expected)
      .filter(([id, digest]) => providerDigest(id, providers, models) === digest)
      .map(([id]) => id);
    if (removed.length === 0) return { removed };
    const gone = new Set(removed);
    const removedAliases = Object.entries(models)
      .filter(([, model]) => model.provider !== undefined && gone.has(model.provider))
      .map(([alias]) => alias);
    await config.replace(PROVIDERS_SECTION, Object.fromEntries(Object.entries(providers).filter(([id]) => !gone.has(id))));
    if (removedAliases.length > 0) {
      await config.replace(MODELS_SECTION, Object.fromEntries(Object.entries(models).filter(([alias]) => !removedAliases.includes(alias))));
    }
    const currentDefault = config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    if (currentDefault !== undefined && removedAliases.includes(currentDefault)) {
      await config.replace(DEFAULT_MODEL_SECTION, Object.keys(config.get<Record<string, ModelRecord> | undefined>(MODELS_SECTION) ?? {})[0]);
    }
    return { removed };
  });
}

export function importSharedProviders(core: Scope, input: unknown): Promise<ProviderCopyResult> {
  return queueProviderWrite(async () => {
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
    return { copied, updated, skipped: [] };
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

export async function fetchHostProviderDigests(session: HostSession, ids: readonly string[]): Promise<Record<string, string>> {
  const response = await session.request({
    method: 'POST',
    path: '/api/v1/hosts:provider-digests',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ providers: ids })),
    timeoutMs: 30_000,
  });
  const body = JSON.parse(response.body.toString('utf8')) as { code?: number; msg?: string; data?: unknown };
  if (response.status !== 200 || body.code !== 0 || body.data === undefined) {
    throw new Error(body.msg ?? 'Unable to read model providers on the SSH host');
  }
  return providerDigestsSchema.parse(body.data).digests;
}

export async function sendProviderRemoval(session: HostSession, digests: Readonly<Record<string, string>>): Promise<ProviderRemoveResult> {
  const response = await session.request({
    method: 'POST',
    path: '/api/v1/hosts:remove-matching-providers',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ providers: digests })),
    timeoutMs: 60_000,
  });
  const body = JSON.parse(response.body.toString('utf8')) as { code?: number; msg?: string; data?: unknown };
  if (response.status !== 200 || body.code !== 0 || body.data === undefined) {
    throw new Error(body.msg ?? 'Unable to remove model providers from the SSH host');
  }
  return providerRemoveResultSchema.parse(body.data);
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
      description: 'Add model providers copied from the connecting computer; providers with the same name here are replaced along with their models',
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

  const digestsRoute = defineRoute(
    {
      method: 'POST',
      path: '/hosts::provider-digests',
      body: providerDigestsBodySchema,
      success: { data: providerDigestsSchema },
      description: 'Hash the named model providers here, with their models, so a connecting computer can tell which of its providers match',
      tags: ['hosts'],
    },
    async (req: { body: unknown; id: string }, reply: { send(payload: unknown): void }) => {
      const { providers } = req.body as z.infer<typeof providerDigestsBodySchema>;
      reply.send(okEnvelope({ digests: await readProviderDigests(core, providers) }, req.id));
    },
  );
  app.post(digestsRoute.path, digestsRoute.options, digestsRoute.handler as never);

  const removeRoute = defineRoute(
    {
      method: 'POST',
      path: '/hosts::remove-matching-providers',
      success: { data: providerRemoveResultSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Remove the named model providers here, with their models, when each still hashes to the digest the connecting computer sent',
      tags: ['hosts'],
    },
    async (req: { body: unknown; id: string }, reply: { send(payload: unknown): void }) => {
      try {
        reply.send(okEnvelope(await removeMatchingProviders(core, req.body), req.id));
      } catch (error) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.post(removeRoute.path, removeRoute.options, removeRoute.handler as never);
}
