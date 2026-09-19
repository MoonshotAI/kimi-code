import { shallowRef, type ShallowRef } from '#/kernel/index';
import { UNKNOWN_CAPABILITY, type LlmModel, type ModelCapability } from '#/llm/model';
import type { Provider } from '#/llm/provider';
import type { LlmRequester } from '#/llm/requester/requester';
import { settleLlmRequest } from '#/llm/requester/settle';

import type {
  CatalogModel,
  CatalogModelBinding,
  CatalogModelDefinition,
  CatalogModelOverrides,
  CatalogProviderEntry,
  CatalogProviderInfo,
  CatalogSnapshot,
  ProviderCatalogPersist,
} from './types';

export interface ProviderStore {
  readonly snapshot: ShallowRef<CatalogSnapshot>;
  providers(): readonly string[];
  providerInfo(providerId: string): CatalogProviderInfo | undefined;
  models(providerId: string): readonly CatalogModel[];
  resolve(providerId: string, model: string): CatalogModelBinding | undefined;
  hydrate(snapshot: CatalogSnapshot): void;
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
  ping(providerId: string, model: string): void;
  dispose(): void;
}

export function createMemoryProviderCatalogStore(): ProviderCatalogPersist {
  let snapshot: CatalogSnapshot | undefined;
  return {
    load: () => Promise.resolve(snapshot),
    save: (value) => {
      snapshot = value;
      return Promise.resolve();
    },
  };
}

export function createProviderStore(options: { snapshot?: CatalogSnapshot } = {}): ProviderStore {
  const snapshot = shallowRef(options.snapshot ?? { providers: {} });
  const live = new Map<string, Provider>();
  let closed = false;
  let pending = Promise.resolve();

  const enqueue = (task: () => Promise<void>): void => {
    pending = pending
      .then(async () => {
        if (!closed) await task();
      })
      .catch(() => {});
  };

  const write = (next: CatalogSnapshot): void => {
    snapshot.value = next;
  };

  const bind = (provider: Provider): void => {
    live.set(provider.id, provider);
  };

  const writeEntry = (
    providerId: string,
    info: CatalogProviderInfo | undefined,
    models: readonly CatalogModelDefinition[] | undefined,
  ): void => {
    write({
      providers: {
        ...snapshot.value.providers,
        [providerId]: {
          info,
          discovered: {},
          override: Object.fromEntries((models ?? []).map((model) => [model.model, model])),
        },
      },
    });
  };

  const applyDiscovered = (providerId: string, models: readonly LlmModel[]): void => {
    const entry = snapshot.value.providers[providerId];
    write({
      providers: {
        ...snapshot.value.providers,
        [providerId]: {
          info: entry?.info,
          override: entry?.override ?? {},
          discovered: Object.fromEntries(models.map((model) => [model.model, model])),
          pingErrors: entry?.pingErrors,
        },
      },
    });
  };

  const applyPing = (providerId: string, model: string, error: string | undefined): void => {
    const entry = snapshot.value.providers[providerId];
    if (entry === undefined) return;
    if (entry.pingErrors?.[model] === error) return;
    const pingErrors = { ...entry.pingErrors };
    if (error === undefined) delete pingErrors[model];
    else pingErrors[model] = error;
    write({
      providers: {
        ...snapshot.value.providers,
        [providerId]: { ...entry, pingErrors },
      },
    });
  };

  const pull = (provider: Provider): void => {
    enqueue(async () => {
      const models = await provider.listModels();
      if (closed || live.get(provider.id) !== provider) return;
      applyDiscovered(provider.id, models);
    });
  };

  return {
    snapshot,
    providers: () => Object.keys(snapshot.value.providers).toSorted(),
    providerInfo: (providerId) => snapshot.value.providers[providerId]?.info,
    models: (providerId) => {
      const entry = snapshot.value.providers[providerId];
      return entry === undefined ? [] : mergeEntryModels(entry);
    },
    resolve: (providerId, model) => {
      const provider = live.get(providerId);
      const entry = snapshot.value.providers[providerId];
      const resolved = resolveCatalogModel(entry, model);
      if (provider === undefined || resolved === undefined) return undefined;
      const catalogModel =
        mergeEntryModels(entry as CatalogProviderEntry).find((item) => item.model === model) ??
        resolved;
      return {
        providerId,
        model: catalogModel,
        createRequester: () => provider.createRequester(resolved.protocol),
      };
    },
    hydrate: (next) => {
      write(next);
    },
    upsert: (input) => {
      bind(input.provider);
      writeEntry(input.provider.id, input.info, input.models);
      pull(input.provider);
    },
    upsertEntry: (input) => {
      writeEntry(input.providerId, input.info, input.models);
    },
    remove: (providerId) => {
      live.delete(providerId);
      const providers = { ...snapshot.value.providers };
      delete providers[providerId];
      write({ providers });
    },
    refresh: (provider) => {
      bind(provider);
      pull(provider);
    },
    ping: (providerId, model) => {
      enqueue(async () => {
        const provider = live.get(providerId);
        const resolved = resolveCatalogModel(snapshot.value.providers[providerId], model);
        if (provider === undefined || resolved === undefined) return;
        applyPing(providerId, model, await runPingProbe(provider, resolved));
      });
    },
    dispose: () => {
      closed = true;
      live.clear();
    },
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
    vertexai: record.vertexai,
    name: record.name,
    aliases: record.aliases,
    oauth: record.oauth,
    extras: record.extras,
  };
  return applyModelOverrides(merged, record.overrides);
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
  const result = await settleLlmRequest(requester, {
    config: {
      model,
      maxCompletionTokens: 512,
    },
    content: {
      systemPrompt: 'You are a connectivity probe. Answer with the single word "pong".',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [],
    },
    signal: new AbortController().signal,
  });
  return result.type === 'failed' ? result.error.message : undefined;
}
