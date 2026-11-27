import type { ProtocolName } from '@moonshot-ai/core/llm/protocol/protocol';
import type { LlmEndpoint, LlmModelSpec, ModelCapability } from '@moonshot-ai/core/llm/request';
import type { ProviderMediaContribution } from '#/media/upload';
import { assign, createActor, emit, enqueueActions, fromPromise, setup, type Actor } from '#/xstate2';

export type CatalogModelSeed = CatalogModelDefinition;

export interface CatalogProviderHandle {
  readonly id: string;
  readonly listModels?: (signal: AbortSignal) => Promise<readonly CatalogModelSeed[]>;
  readonly media?: ProviderMediaContribution;
}

type Provider = CatalogProviderHandle;

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

export interface CatalogModelDefinition {
  readonly id: string;
  readonly spec: LlmModelSpec;
  readonly endpoint?: LlmEndpoint;
  readonly apiKey?: string;
  readonly displayName?: string;
  readonly maxOutputSize?: number;
  readonly reasoningKey?: string;
  readonly protocol?: ProtocolName;
  readonly betaApi?: boolean;
  readonly vertexai?: boolean;
  readonly aliases?: readonly string[];
  readonly oauth?: CatalogOAuthRef;
  readonly overrides?: CatalogModelOverrides;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface CatalogProviderInfo {
  readonly type?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly baseUrl?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly cacheTtl?: '5m' | '1h';
  readonly defaultModel?: string;
  readonly oauth?: CatalogOAuthRef;
  readonly env?: Readonly<Record<string, string>>;
  readonly modelSource?: 'static' | 'discover' | 'oauth-catalog';
  readonly source?: Readonly<Record<string, unknown>>;
}

export interface CatalogProviderEntry {
  readonly info?: CatalogProviderInfo;
  readonly discovered: Readonly<Record<string, CatalogModelSeed>>;
  readonly override: Readonly<Record<string, CatalogModelDefinition>>;
}

export type CatalogModel = CatalogModelDefinition;

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
  | { type: 'refresh'; providers: readonly Provider[] };

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

interface ProviderCatalogContext {
  readonly snapshot: CatalogSnapshot;
  readonly batch: readonly Provider[];
  readonly queue: readonly Provider[];
  readonly dirty: readonly string[];
  readonly failures: readonly RefreshFailure[];
}

interface PullResult {
  readonly providerId: string;
  readonly models?: readonly CatalogModelSeed[];
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
        discovered: Object.fromEntries(result.models.map((model) => [model.id, model])),
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

function mergeEntryModels(entry: CatalogProviderEntry): CatalogModel[] {
  const merged = Object.values(entry.override).map((record) =>
    mergeModel(record, entry.discovered[record.id]),
  );
  const discoveredOnly = Object.values(entry.discovered)
    .filter((model) => entry.override[model.id] === undefined)
    .map((model) => mergeModel({ ...model }, undefined));
  return [...merged, ...discoveredOnly].toSorted((a, b) => a.id.localeCompare(b.id));
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
      pullBatch: fromPromise<PullResult[], readonly Provider[]>(async ({ input: providers, signal }) =>
        Promise.all(
          providers.map(async (provider): Promise<PullResult> => {
            try {
              return {
                providerId: provider.id,
                models: await (provider.listModels?.(signal) ?? []),
              };
            } catch (error) {
              return { providerId: provider.id, error };
            }
          }),
        ),
      ),
    },
  }).createMachine({
    id: 'providerCatalog',
    context: ({ input }) => ({
      snapshot: input ?? { providers: {} },
      batch: [],
      queue: [],
      dirty: [],
      failures: [],
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
                    (event.models ?? []).map((model) => [model.id, model]),
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
          refresh: {
            actions: assign(({ context, event }) => ({
              queue: enqueueProviders(context.batch, context.queue, event.providers),
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
  upsertEntry(input: {
    providerId: string;
    info?: CatalogProviderInfo;
    models?: readonly CatalogModelDefinition[];
  }): void;
  remove(providerId: string): void;
  refresh(provider: Provider): void;
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
): ModelCapability | undefined {
  if (discovered === undefined) return override;
  if (override === undefined) return discovered;
  const either = (left: boolean | undefined, right: boolean | undefined): boolean | undefined =>
    left === undefined && right === undefined ? undefined : left === true || right === true;
  return {
    image_in: either(discovered.image_in, override.image_in),
    video_in: either(discovered.video_in, override.video_in),
    audio_in: either(discovered.audio_in, override.audio_in),
    thinking: either(discovered.thinking, override.thinking),
    tool_use: either(discovered.tool_use, override.tool_use),
    dynamically_loaded_tools: either(
      discovered.dynamically_loaded_tools,
      override.dynamically_loaded_tools,
    ),
  };
}

function clampMaxInputSize(model: CatalogModelDefinition): CatalogModelDefinition {
  const { maxInputSize, maxContextSize } = model.spec;
  if (
    maxInputSize !== undefined &&
    maxContextSize !== undefined &&
    maxInputSize > maxContextSize
  ) {
    return { ...model, spec: { ...model.spec, maxInputSize: maxContextSize } };
  }
  return model;
}

function applyModelOverrides(
  model: CatalogModelDefinition,
  overrides: CatalogModelOverrides | undefined,
): CatalogModelDefinition {
  if (overrides === undefined) return model;
  const {
    capability,
    maxContextSize,
    maxInputSize,
    supportEfforts,
    defaultEffort,
    offEffort,
    alwaysThinking,
    adaptiveThinking,
    ...modelOverrides
  } = overrides;
  const hasThinkingOverride =
    supportEfforts !== undefined ||
    defaultEffort !== undefined ||
    offEffort !== undefined ||
    alwaysThinking !== undefined ||
    adaptiveThinking !== undefined;
  const effective: CatalogModelDefinition = {
    ...model,
    ...modelOverrides,
    spec: {
      ...model.spec,
      capability: capability ?? model.spec.capability,
      maxContextSize: maxContextSize ?? model.spec.maxContextSize,
      maxInputSize: maxInputSize ?? model.spec.maxInputSize,
      thinking:
        model.spec.thinking === undefined && !hasThinkingOverride
          ? undefined
          : {
              supportEfforts: supportEfforts ?? model.spec.thinking?.supportEfforts,
              defaultEffort: defaultEffort ?? model.spec.thinking?.defaultEffort,
              offEffort: offEffort ?? model.spec.thinking?.offEffort,
              alwaysThinking: alwaysThinking ?? model.spec.thinking?.alwaysThinking,
              adaptiveThinking: adaptiveThinking ?? model.spec.thinking?.adaptiveThinking,
            },
    },
  };
  const effectiveDefault = effective.spec.thinking?.defaultEffort;
  if (
    supportEfforts !== undefined &&
    defaultEffort === undefined &&
    effectiveDefault !== undefined &&
    !supportEfforts.includes(effectiveDefault)
  ) {
    const { defaultEffort: _dropped, ...thinking } = effective.spec.thinking!;
    return clampMaxInputSize({
      ...effective,
      spec: { ...effective.spec, thinking },
    });
  }
  return clampMaxInputSize(effective);
}

function mergeModel(
  record: CatalogModelSeed,
  discovered: CatalogModelSeed | undefined,
): CatalogModelDefinition {
  const endpoint =
    record.endpoint === undefined && discovered?.endpoint === undefined
      ? undefined
      : {
          ...discovered?.endpoint,
          ...record.endpoint,
          baseUrl: record.endpoint?.baseUrl ?? discovered?.endpoint?.baseUrl,
          headers: record.endpoint?.headers ?? discovered?.endpoint?.headers,
        };
  const merged: CatalogModelDefinition = {
    id: record.id,
    spec: {
      provider: record.spec.provider,
      name: record.spec.name,
      capability: mergeCapability(discovered?.spec.capability, record.spec.capability),
      thinking: record.spec.thinking,
      maxContextSize: record.spec.maxContextSize ?? discovered?.spec.maxContextSize,
      maxInputSize: record.spec.maxInputSize ?? discovered?.spec.maxInputSize,
    },
    endpoint,
    apiKey: record.apiKey ?? discovered?.apiKey,
    displayName: record.displayName,
    maxOutputSize: record.maxOutputSize,
    reasoningKey: record.reasoningKey,
    protocol: record.protocol,
    betaApi: record.betaApi,
    vertexai: record.vertexai,
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
  return buildProviderCatalog(actor, options.store);
}

export function createProviderCatalogSync(
  options: {
    snapshot?: CatalogSnapshot;
  } = {},
): ProviderCatalog {
  const actor = createActor(createProviderCatalogMachine(), { input: options.snapshot });
  actor.start();
  return buildProviderCatalog(actor, undefined);
}

function buildProviderCatalog(
  actor: Actor<ReturnType<typeof createProviderCatalogMachine>>,
  store: ProviderCatalogStore | undefined,
): ProviderCatalog {
  if (store !== undefined) {
    actor.on('changed', () => {
      void store.save(actor.getSnapshot().context.snapshot);
    });
  }

  const read = (): CatalogSnapshot => actor.getSnapshot().context.snapshot;

  return {
    providers: () => Object.keys(read().providers).toSorted(),
    providerInfo: (providerId) => read().providers[providerId]?.info,
    models: (providerId) => {
      const entry = read().providers[providerId];
      return entry === undefined ? [] : mergeEntryModels(entry);
    },
    upsert: (input) => {
      actor.send({
        type: 'upsert',
        providerId: input.provider.id,
        info: input.info,
        models: input.models,
      });
      actor.send({ type: 'refresh', providers: [input.provider] });
    },
    upsertEntry: (input) => {
      actor.send({
        type: 'upsert',
        providerId: input.providerId,
        info: input.info,
        models: input.models,
      });
    },
    remove: (providerId) => {
      actor.send({ type: 'remove', providerId });
    },
    refresh: (provider) => {
      actor.send({ type: 'refresh', providers: [provider] });
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
      actor.stop();
    },
  };
}
