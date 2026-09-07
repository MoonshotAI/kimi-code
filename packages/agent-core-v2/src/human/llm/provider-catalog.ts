import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/llm/capability';
import type { LlmErrorMessage } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import type { ProtocolName } from '#/llm/protocol/base';
import type { Provider } from '#/llm/provider/definition';
import type { LlmRequester } from '#/llm/requester/requester';
import { assign, createActor, emit, enqueueActions, fromPromise, setup } from '#/xstate2';

export interface CatalogOAuthRef {
  readonly storage: 'file' | 'keyring';
  readonly key: string;
  readonly oauthHost?: string;
}

export interface CatalogModelOverrides {
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly capability?: ModelCapability;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly adaptiveThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
}

export interface CatalogModelDefinition extends LlmModel {
  readonly displayName?: string;
  readonly maxOutputSize?: number;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
  readonly protocol?: ProtocolName;
  readonly defaultEffort?: string;
  readonly adaptiveThinking?: boolean;
  readonly betaApi?: boolean;
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly oauth?: CatalogOAuthRef;
  readonly overrides?: CatalogModelOverrides;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface CatalogProviderInfo {
  readonly type?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly defaultModel?: string;
  readonly oauth?: CatalogOAuthRef;
  readonly env?: Readonly<Record<string, string>>;
  readonly modelSource?: 'static' | 'discover' | 'oauth-catalog';
  readonly source?: Readonly<Record<string, unknown>>;
}

export interface CatalogProviderEntry {
  readonly info?: CatalogProviderInfo;
  readonly discovered: Readonly<Record<string, LlmModel>>;
  readonly override: Readonly<Record<string, CatalogModelDefinition>>;
  readonly pingErrors?: Readonly<Record<string, string>>;
}

export interface CatalogModel extends CatalogModelDefinition {
  readonly pingError?: string;
}

export interface CatalogSnapshot {
  readonly providers: Readonly<Record<string, CatalogProviderEntry>>;
}

export interface ProviderCatalogStore {
  load(): Promise<CatalogSnapshot | undefined>;
  save(snapshot: CatalogSnapshot): Promise<void>;
}

export type ProviderCatalogEvent =
  | {
      type: 'upsert';
      providerId: string;
      info?: CatalogProviderInfo;
      models?: readonly CatalogModelDefinition[];
    }
  | { type: 'remove'; providerId: string }
  | { type: 'refresh'; providers: readonly Provider[] }
  | { type: 'ping'; provider: Provider; model: string };

export type ProviderCatalogEmitted =
  | { readonly type: 'changed'; readonly providers: readonly string[] }
  | { readonly type: 'refresh-failed'; readonly providerId: string; readonly error: unknown };

export type ProviderCatalogChanged = Extract<ProviderCatalogEmitted, { type: 'changed' }>;

export type ProviderCatalogRefreshFailed = Extract<
  ProviderCatalogEmitted,
  { type: 'refresh-failed' }
>;

interface RefreshFailure {
  readonly providerId: string;
  readonly error: unknown;
}

interface PingRequest {
  readonly provider: Provider;
  readonly model: CatalogModelDefinition;
}

interface PingOutcome {
  readonly providerId: string;
  readonly model: string;
  readonly error?: string;
}

interface ProviderCatalogContext {
  readonly snapshot: CatalogSnapshot;
  readonly batch: readonly Provider[];
  readonly queue: readonly Provider[];
  readonly dirty: readonly string[];
  readonly failures: readonly RefreshFailure[];
  readonly ping?: PingRequest;
  readonly pingQueue: readonly PingRequest[];
}

interface PullResult {
  readonly providerId: string;
  readonly models?: readonly LlmModel[];
  readonly error?: unknown;
}

function applyPullResults(
  snapshot: CatalogSnapshot,
  results: readonly PullResult[],
): CatalogSnapshot {
  let providers = snapshot.providers;
  for (const result of results) {
    if (result.models === undefined) continue;
    const entry = providers[result.providerId];
    providers = {
      ...providers,
      [result.providerId]: {
        info: entry?.info,
        override: entry?.override ?? {},
        discovered: Object.fromEntries(result.models.map((model) => [model.model, model])),
        pingErrors: entry?.pingErrors,
      },
    };
  }
  return { providers };
}

function pullFailures(results: readonly PullResult[]): RefreshFailure[] {
  return results
    .filter((result) => result.models === undefined)
    .map((result) => ({ providerId: result.providerId, error: result.error }));
}

function mergeDirty(dirty: readonly string[], results: readonly PullResult[]): string[] {
  const succeeded = results
    .filter((result) => result.models !== undefined)
    .map((result) => result.providerId);
  return [...new Set([...dirty, ...succeeded])].toSorted();
}

function enqueueProviders(
  batch: readonly Provider[],
  queue: readonly Provider[],
  incoming: readonly Provider[],
): readonly Provider[] {
  const active = new Set([...batch, ...queue].map((provider) => provider.id));
  return [...queue, ...incoming.filter((provider) => !active.has(provider.id))];
}

function applyPingOutcome(
  snapshot: CatalogSnapshot,
  outcome: PingOutcome,
): { snapshot: CatalogSnapshot; changed: boolean } {
  const entry = snapshot.providers[outcome.providerId];
  if (entry === undefined) return { snapshot, changed: false };
  if (entry.pingErrors?.[outcome.model] === outcome.error) return { snapshot, changed: false };
  const pingErrors = { ...entry.pingErrors };
  if (outcome.error === undefined) delete pingErrors[outcome.model];
  else pingErrors[outcome.model] = outcome.error;
  return {
    snapshot: {
      providers: {
        ...snapshot.providers,
        [outcome.providerId]: { ...entry, pingErrors },
      },
    },
    changed: true,
  };
}

function resolveCatalogModel(
  entry: CatalogProviderEntry | undefined,
  modelId: string,
): CatalogModelDefinition | undefined {
  if (entry === undefined) return undefined;
  const override = entry.override[modelId];
  if (override !== undefined) return mergeModel(override, entry.discovered[modelId]);
  const discovered = entry.discovered[modelId];
  if (discovered === undefined) return undefined;
  return mergeModel({ ...discovered }, undefined);
}

function mergeEntryModels(entry: CatalogProviderEntry): CatalogModel[] {
  const attach = (model: CatalogModelDefinition): CatalogModel => {
    const pingError = entry.pingErrors?.[model.model];
    return pingError === undefined ? model : { ...model, pingError };
  };
  const merged = Object.values(entry.override).map((record) =>
    attach(mergeModel(record, entry.discovered[record.model])),
  );
  const discoveredOnly = Object.values(entry.discovered)
    .filter((model) => entry.override[model.model] === undefined)
    .map((model) => attach(mergeModel({ ...model }, undefined)));
  return [...merged, ...discoveredOnly].toSorted((a, b) => a.model.localeCompare(b.model));
}

function enqueuePing(
  active: PingRequest | undefined,
  queue: readonly PingRequest[],
  request: PingRequest,
): readonly PingRequest[] {
  const keyOf = (ping: PingRequest): string => `${ping.provider.id}#${ping.model.model}`;
  if (active !== undefined && keyOf(active) === keyOf(request)) return queue;
  if (queue.some((ping) => keyOf(ping) === keyOf(request))) return queue;
  return [...queue, request];
}

async function runPingProbe(
  provider: Provider,
  model: CatalogModelDefinition,
): Promise<string | undefined> {
  let requester: LlmRequester;
  try {
    requester = provider.createRequester(model.protocol);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  let failure: LlmErrorMessage | undefined;
  try {
    await requester.generate(
      {
        model,
        systemPrompt: 'You are a connectivity probe. Answer with the single word "pong".',
        tools: [],
        maxCompletionTokens: 512,
      },
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.failed.syntax' || event.type === 'llm.failed.remote') {
            failure = event.error;
          }
        },
      },
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return failure?.message;
}

export function createProviderCatalogMachine() {
  return setup({
    types: {
      context: {} as ProviderCatalogContext,
      events: {} as ProviderCatalogEvent,
      emitted: {} as ProviderCatalogEmitted,
      input: {} as CatalogSnapshot | undefined,
    },
    actors: {
      pullBatch: fromPromise<PullResult[], readonly Provider[]>(async ({ input: providers }) =>
        Promise.all(
          providers.map(async (provider): Promise<PullResult> => {
            try {
              return { providerId: provider.id, models: await provider.listModels() };
            } catch (error) {
              return { providerId: provider.id, error };
            }
          }),
        ),
      ),
      pingModel: fromPromise<PingOutcome, PingRequest>(async ({ input }) => ({
        providerId: input.provider.id,
        model: input.model.model,
        error: await runPingProbe(input.provider, input.model),
      })),
    },
  }).createMachine({
    id: 'providerCatalog',
    context: ({ input }) => ({
      snapshot: input ?? { providers: {} },
      batch: [],
      queue: [],
      dirty: [],
      failures: [],
      pingQueue: [],
    }),
    initial: 'idle',
    on: {
      upsert: {
        actions: [
          assign(({ context, event }) => ({
            snapshot: {
              providers: {
                ...context.snapshot.providers,
                [event.providerId]: {
                  info: event.info,
                  discovered: {},
                  override: Object.fromEntries(
                    (event.models ?? []).map((model) => [model.model, model]),
                  ),
                },
              },
            },
          })),
          emit(({ event }) => ({ type: 'changed' as const, providers: [event.providerId] })),
        ],
      },
      remove: {
        actions: [
          assign(({ context, event }) => {
            const providers = { ...context.snapshot.providers };
            delete providers[event.providerId];
            return { snapshot: { providers } };
          }),
          emit(({ event }) => ({ type: 'changed' as const, providers: [event.providerId] })),
        ],
      },
    },
    states: {
      idle: {
        on: {
          ping: [
            {
              guard: ({ context, event }) =>
                resolveCatalogModel(context.snapshot.providers[event.provider.id], event.model) !==
                undefined,
              target: 'pinging',
              actions: assign(({ context, event }) => {
                const model = resolveCatalogModel(
                  context.snapshot.providers[event.provider.id],
                  event.model,
                );
                return model === undefined ? {} : { ping: { provider: event.provider, model } };
              }),
            },
            {},
          ],
          refresh: {
            target: 'refreshing',
            actions: assign(({ event }) => ({
              batch: event.providers,
              queue: [],
              dirty: [],
              failures: [],
            })),
          },
        },
      },
      refreshing: {
        invoke: {
          src: 'pullBatch',
          input: ({ context }) => context.batch,
          onDone: [
            {
              guard: ({ context }) => context.queue.length > 0,
              target: 'refreshing',
              reenter: true,
              actions: assign(({ context, event }) => ({
                snapshot: applyPullResults(context.snapshot, event.output),
                batch: context.queue,
                queue: [],
                dirty: mergeDirty(context.dirty, event.output),
                failures: [...context.failures, ...pullFailures(event.output)],
              })),
            },
            {
              guard: ({ context }) => context.pingQueue.length > 0,
              target: 'pinging',
              actions: [
                assign(({ context, event }) => ({
                  snapshot: applyPullResults(context.snapshot, event.output),
                  ping: context.pingQueue.at(0) as PingRequest,
                  pingQueue: context.pingQueue.slice(1),
                })),
                enqueueActions(({ context, event, enqueue }) => {
                  const providers = mergeDirty(context.dirty, event.output);
                  if (providers.length > 0) {
                    enqueue.emit({ type: 'changed', providers });
                  }
                  for (const failure of [...context.failures, ...pullFailures(event.output)]) {
                    enqueue.emit({
                      type: 'refresh-failed',
                      providerId: failure.providerId,
                      error: failure.error,
                    });
                  }
                }),
              ],
            },
            {
              target: 'idle',
              actions: [
                assign(({ context, event }) => ({
                  snapshot: applyPullResults(context.snapshot, event.output),
                })),
                enqueueActions(({ context, event, enqueue }) => {
                  const providers = mergeDirty(context.dirty, event.output);
                  if (providers.length > 0) {
                    enqueue.emit({ type: 'changed', providers });
                  }
                  for (const failure of [...context.failures, ...pullFailures(event.output)]) {
                    enqueue.emit({
                      type: 'refresh-failed',
                      providerId: failure.providerId,
                      error: failure.error,
                    });
                  }
                }),
              ],
            },
          ],
        },
        on: {
          ping: {
            actions: assign(({ context, event }) => {
              const model = resolveCatalogModel(
                context.snapshot.providers[event.provider.id],
                event.model,
              );
              if (model === undefined) return {};
              return {
                pingQueue: enqueuePing(context.ping, context.pingQueue, {
                  provider: event.provider,
                  model,
                }),
              };
            }),
          },
          refresh: {
            actions: assign(({ context, event }) => ({
              queue: enqueueProviders(context.batch, context.queue, event.providers),
            })),
          },
        },
      },
      pinging: {
        invoke: {
          src: 'pingModel',
          input: ({ context }) => context.ping as PingRequest,
          onDone: [
            {
              guard: ({ context }) => context.pingQueue.length > 0,
              target: 'pinging',
              reenter: true,
              actions: enqueueActions(({ context, event, enqueue }) => {
                const outcome = applyPingOutcome(context.snapshot, event.output);
                enqueue.assign({
                  snapshot: outcome.snapshot,
                  ping: context.pingQueue.at(0) as PingRequest,
                  pingQueue: context.pingQueue.slice(1),
                });
                if (outcome.changed) {
                  enqueue.emit({
                    type: 'changed',
                    providers: [event.output.providerId],
                  });
                }
              }),
            },
            {
              guard: ({ context }) => context.queue.length > 0,
              target: 'refreshing',
              actions: enqueueActions(({ context, event, enqueue }) => {
                const outcome = applyPingOutcome(context.snapshot, event.output);
                enqueue.assign({
                  snapshot: outcome.snapshot,
                  ping: undefined,
                  batch: context.queue,
                  queue: [],
                  dirty: [],
                  failures: [],
                });
                if (outcome.changed) {
                  enqueue.emit({
                    type: 'changed',
                    providers: [event.output.providerId],
                  });
                }
              }),
            },
            {
              target: 'idle',
              actions: enqueueActions(({ context, event, enqueue }) => {
                const outcome = applyPingOutcome(context.snapshot, event.output);
                enqueue.assign({ snapshot: outcome.snapshot, ping: undefined });
                if (outcome.changed) {
                  enqueue.emit({
                    type: 'changed',
                    providers: [event.output.providerId],
                  });
                }
              }),
            },
          ],
        },
        on: {
          ping: {
            actions: assign(({ context, event }) => {
              const model = resolveCatalogModel(
                context.snapshot.providers[event.provider.id],
                event.model,
              );
              if (model === undefined) return {};
              return {
                pingQueue: enqueuePing(context.ping, context.pingQueue, {
                  provider: event.provider,
                  model,
                }),
              };
            }),
          },
          refresh: {
            actions: assign(({ context, event }) => ({
              queue: enqueueProviders([], context.queue, event.providers),
            })),
          },
        },
      },
    },
  });
}

export interface ProviderCatalog {
  providers(): readonly string[];
  providerInfo(providerId: string): CatalogProviderInfo | undefined;
  models(providerId: string): readonly CatalogModel[];
  upsert(input: {
    provider: Provider;
    info?: CatalogProviderInfo;
    models?: readonly CatalogModelDefinition[];
  }): void;
  remove(providerId: string): void;
  refresh(provider: Provider): void;
  ping(providerId: string, model: string): void;
  onChanged(listener: (event: ProviderCatalogChanged) => void): () => void;
  onRefreshFailed(listener: (event: ProviderCatalogRefreshFailed) => void): () => void;
  stop(): void;
}

export function createMemoryProviderCatalogStore(): ProviderCatalogStore {
  let snapshot: CatalogSnapshot | undefined;
  return {
    load: () => Promise.resolve(snapshot),
    save: (value) => {
      snapshot = value;
      return Promise.resolve();
    },
  };
}

function mergeCapability(
  discovered: ModelCapability | undefined,
  override: ModelCapability | undefined,
): ModelCapability {
  if (discovered === undefined) {
    return override ?? UNKNOWN_CAPABILITY;
  }
  if (override === undefined) {
    return discovered;
  }
  return {
    image_in: discovered.image_in || override.image_in,
    video_in: discovered.video_in || override.video_in,
    audio_in: discovered.audio_in || override.audio_in,
    thinking: discovered.thinking || override.thinking,
    tool_use: discovered.tool_use || override.tool_use,
    dynamically_loaded_tools:
      discovered.dynamically_loaded_tools === true || override.dynamically_loaded_tools === true,
  };
}

function clampMaxInputSize(model: CatalogModelDefinition): CatalogModelDefinition {
  if (
    model.maxInputSize !== undefined &&
    model.maxContextSize !== undefined &&
    model.maxInputSize > model.maxContextSize
  ) {
    return { ...model, maxInputSize: model.maxContextSize };
  }
  return model;
}

function applyModelOverrides(
  model: CatalogModelDefinition,
  overrides: CatalogModelOverrides | undefined,
): CatalogModelDefinition {
  if (overrides === undefined) return model;
  const effective: CatalogModelDefinition = { ...model, ...overrides };
  if (
    overrides.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    const { defaultEffort: _dropped, ...rest } = effective;
    return clampMaxInputSize(rest);
  }
  return clampMaxInputSize(effective);
}

function mergeModel(
  record: CatalogModelDefinition,
  discovered: LlmModel | undefined,
): CatalogModelDefinition {
  const merged: CatalogModelDefinition = {
    provider: record.provider,
    model: record.model,
    capability: mergeCapability(discovered?.capability, record.capability),
    maxContextSize: record.maxContextSize ?? discovered?.maxContextSize,
    maxInputSize: record.maxInputSize ?? discovered?.maxInputSize,
    baseUrl: record.baseUrl ?? discovered?.baseUrl,
    apiKey: record.apiKey ?? discovered?.apiKey,
    defaultHeaders: record.defaultHeaders ?? discovered?.defaultHeaders,
    displayName: record.displayName,
    maxOutputSize: record.maxOutputSize,
    reasoningKey: record.reasoningKey,
    supportEfforts: record.supportEfforts,
    offEffort: record.offEffort,
    alwaysThinking: record.alwaysThinking,
    protocol: record.protocol,
    defaultEffort: record.defaultEffort,
    adaptiveThinking: record.adaptiveThinking,
    betaApi: record.betaApi,
    name: record.name,
    aliases: record.aliases,
    oauth: record.oauth,
    extras: record.extras,
  };
  return applyModelOverrides(merged, record.overrides);
}

export async function createProviderCatalog(
  options: {
    store?: ProviderCatalogStore;
    snapshot?: CatalogSnapshot;
  } = {},
): Promise<ProviderCatalog> {
  const loaded = options.snapshot ?? (await options.store?.load());
  const actor = createActor(createProviderCatalogMachine(), { input: loaded });
  actor.start();

  if (options.store !== undefined) {
    const store = options.store;
    actor.on('changed', () => {
      void store.save(actor.getSnapshot().context.snapshot);
    });
  }

  const read = (): CatalogSnapshot => actor.getSnapshot().context.snapshot;
  const live = new Map<string, Provider>();

  return {
    providers: () => Object.keys(read().providers).toSorted(),
    providerInfo: (providerId) => read().providers[providerId]?.info,
    models: (providerId) => {
      const entry = read().providers[providerId];
      return entry === undefined ? [] : mergeEntryModels(entry);
    },
    upsert: (input) => {
      live.set(input.provider.id, input.provider);
      actor.send({
        type: 'upsert',
        providerId: input.provider.id,
        info: input.info,
        models: input.models,
      });
      actor.send({ type: 'refresh', providers: [input.provider] });
    },
    remove: (providerId) => {
      live.delete(providerId);
      actor.send({ type: 'remove', providerId });
    },
    refresh: (provider) => {
      live.set(provider.id, provider);
      actor.send({ type: 'refresh', providers: [provider] });
    },
    ping: (providerId, model) => {
      const provider = live.get(providerId);
      if (provider === undefined) return;
      actor.send({ type: 'ping', provider, model });
    },
    onChanged: (listener) => {
      const subscription = actor.on('changed', listener);
      return () => {
        subscription.unsubscribe();
      };
    },
    onRefreshFailed: (listener) => {
      const subscription = actor.on('refresh-failed', listener);
      return () => {
        subscription.unsubscribe();
      };
    },
    stop: () => {
      live.clear();
      actor.stop();
    },
  };
}
