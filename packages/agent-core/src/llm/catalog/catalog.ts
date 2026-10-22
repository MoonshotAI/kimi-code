import { createUserMessage } from '#/llm/message';
import type { LlmRequester } from '#/llm/requester';
import { now } from '#/utils/now';
import { abortReason } from '#/utils/wait';

import { listSnapshotModels, resolveSnapshotModel } from './merge';
import type {
  CatalogModel,
  CatalogModelDefinition,
  CatalogProviderHandle,
  CatalogProviderInfo,
  CatalogSnapshot,
  CreateProviderCatalogOptions,
  ProviderCatalog,
  ProviderCatalogChangedEvent,
  ProviderCatalogPingResult,
  ProviderCatalogRefreshFailedEvent,
  ProviderCatalogStore,
  ProviderRequesterSource,
} from './types';

interface PullResult {
  readonly providerId: string;
  readonly models?: readonly CatalogModelDefinition[];
  readonly error?: unknown;
}

interface RefreshFailure {
  readonly providerId: string;
  readonly error: unknown;
}

interface PingRequest {
  readonly providerId: string;
  readonly modelId: string;
}

interface PingTask extends PingRequest {
  readonly promise: Promise<ProviderCatalogPingResult>;
  readonly resolve: (result: ProviderCatalogPingResult) => void;
  readonly reject: (error: unknown) => void;
  readonly startedAt: number;
  settled: boolean;
}

interface PingOutcome {
  readonly providerId: string;
  readonly modelId: string;
  readonly error?: string;
}

function isRequester(value: ProviderRequesterSource): value is LlmRequester<'protocol'> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'with' in value &&
    typeof value.with === 'function' &&
    'generate' in value &&
    typeof value.generate === 'function'
  );
}

function resolveBaseRequester(
  source: ProviderRequesterSource | undefined,
  protocol: string | undefined,
  model: CatalogModel,
): LlmRequester<'protocol'> | undefined {
  if (source === undefined) return undefined;
  if (typeof source === 'function') return source(protocol, model);
  if (isRequester(source)) return source;
  if (protocol !== undefined) return source[protocol];
  return Object.values(source)[0];
}

function buildModelRequester(
  handle: CatalogProviderHandle | undefined,
  info: CatalogProviderInfo | undefined,
  model: CatalogModel | undefined,
): LlmRequester<'protocol' | 'model'> | undefined {
  if (handle === undefined || model === undefined) return undefined;
  const base = resolveBaseRequester(handle.requester, model.protocol, model);
  if (base === undefined) return undefined;

  return base
    .with({ endpoint: handle.endpoint })
    .with({
      endpoint: {
        baseUrl: info?.baseUrl,
        headers: info?.customHeaders,
      },
    })
    .with({
      protocol: { options: model.protocolOptions },
      endpoint: model.endpoint,
      model: {
        spec: model,
        thinking: model.defaultThinking,
        maxOutputTokens: model.maxOutputTokens,
        responseFormat: model.responseFormat,
        sampling: model.sampling,
        cacheKey: model.cacheKey,
      },
    });
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

function applyPingOutcome(
  snapshot: CatalogSnapshot,
  outcome: PingOutcome,
): { readonly snapshot: CatalogSnapshot; readonly changed: boolean } {
  const entry = snapshot.providers[outcome.providerId];
  if (entry === undefined) return { snapshot, changed: false };
  if (entry.pingErrors?.[outcome.modelId] === outcome.error) return { snapshot, changed: false };
  const pingErrors = { ...entry.pingErrors };
  if (outcome.error === undefined) delete pingErrors[outcome.modelId];
  else pingErrors[outcome.modelId] = outcome.error;
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

function pingKey(request: PingRequest): string {
  return `${request.providerId}#${request.modelId}`;
}

export function createMemoryProviderCatalogStore(
  initial?: CatalogSnapshot,
): ProviderCatalogStore {
  let snapshot = initial;
  return {
    load: () => Promise.resolve(snapshot),
    save: (value) => {
      snapshot = value;
      return Promise.resolve();
    },
  };
}

export async function createProviderCatalog(
  options: CreateProviderCatalogOptions = {},
): Promise<ProviderCatalog> {
  let snapshot: CatalogSnapshot = options.snapshot ?? (await options.store?.load()) ?? {
    providers: {},
  };
  const store = options.store;
  const pingTimeoutMs = options.pingTimeoutMs;
  const handles = new Map<string, CatalogProviderHandle>();
  for (const handle of options.handles ?? []) {
    handles.set(handle.id, handle);
  }

  const changedListeners = new Set<(event: ProviderCatalogChangedEvent) => void>();
  const failedListeners = new Set<(event: ProviderCatalogRefreshFailedEvent) => void>();
  const pingTasks = new Map<string, PingTask>();

  let state: 'idle' | 'refreshing' | 'pinging' = 'idle';
  let closed = false;
  let activeController: AbortController | undefined;

  let batch: string[] = [];
  let queue: string[] = [];
  let dirty: string[] = [];
  let failures: RefreshFailure[] = [];
  let activePing: PingTask | undefined;
  let pingQueue: PingTask[] = [];

  const emitChanged = (providers: readonly string[]): void => {
    if (closed || providers.length === 0) return;
    if (store !== undefined) {
      void store.save(snapshot);
    }
    const event: ProviderCatalogChangedEvent = { type: 'changed', providers };
    for (const listener of changedListeners) {
      listener(event);
    }
  };

  const emitRefreshFailed = (failure: RefreshFailure): void => {
    if (closed) return;
    const event: ProviderCatalogRefreshFailedEvent = {
      type: 'refresh-failed',
      providerId: failure.providerId,
      error: failure.error,
    };
    for (const listener of failedListeners) {
      listener(event);
    }
  };

  const getModel = (providerId: string, modelId: string): CatalogModel | undefined =>
    resolveSnapshotModel(providerId, snapshot.providers[providerId], modelId);

  const getRequester = (
    providerId: string,
    modelId: string,
  ): LlmRequester<'protocol' | 'model'> | undefined =>
    buildModelRequester(
      handles.get(providerId),
      snapshot.providers[providerId]?.info,
      getModel(providerId, modelId),
    );

  const pullOne = async (providerId: string, signal: AbortSignal): Promise<PullResult> => {
    const handle = handles.get(providerId);
    if (handle?.listModels === undefined) {
      return { providerId, models: [] };
    }
    try {
      return { providerId, models: await handle.listModels(signal) };
    } catch (error) {
      return { providerId, error };
    }
  };

  const settlePing = (task: PingTask, result: ProviderCatalogPingResult): void => {
    if (task.settled) return;
    task.settled = true;
    pingTasks.delete(pingKey(task));
    task.resolve(result);
  };

  const rejectPing = (task: PingTask, error: unknown): void => {
    if (task.settled) return;
    task.settled = true;
    pingTasks.delete(pingKey(task));
    task.reject(error);
  };

  const probeOne = async (
    request: PingTask,
    signal: AbortSignal,
  ): Promise<ProviderCatalogPingResult> => {
    const requester = getRequester(request.providerId, request.modelId);
    if (requester === undefined) {
      throw new Error(`No requester configured for ${request.providerId}/${request.modelId}`);
    }
    const rest = {
      model: { maxOutputTokens: 512 },
      profile: {
        systemPrompt: 'You are a connectivity probe. Answer with the single word "pong".',
        tools: [],
      },
      content: { messages: [createUserMessage('ping')] },
      policy: { recoveries: [], retry: { maxAttemptsPerStep: 1 } },
    };
    try {
      const credentials = requester.request(rest).endpoint?.credentials;
      let removeAbortListener = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          reject(abortReason(signal));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => {
          signal.removeEventListener('abort', onAbort);
        };
      });
      try {
        const generate = () => Promise.race([requester.generate(rest, { signal }), aborted]);
        let outcome = await generate();
        if (
          outcome.type === 'failed' &&
          !signal.aborted &&
          credentials?.canRecover?.(outcome.error) === true
        ) {
          credentials.invalidate?.();
          outcome = await generate();
        }
        const durationMs = now() - request.startedAt;
        if (outcome.type === 'failed') {
          return { ok: false, durationMs, error: outcome.error.message };
        }
        if (outcome.type === 'aborted') {
          const reason = outcome.reason ?? signal.reason;
          return {
            ok: false,
            durationMs,
            error:
              reason instanceof Error
                ? reason.message
                : reason === undefined
                  ? 'aborted'
                  : String(reason),
          };
        }
        return {
          ok: true,
          durationMs,
          text: outcome.message.content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('')
            .trim(),
          usage: outcome.usage,
          finishReason:
            outcome.finish?.finishReason ?? outcome.finish?.rawFinishReason ?? undefined,
        };
      } finally {
        removeAbortListener();
      }
    } catch (error) {
      return {
        ok: false,
        durationMs: now() - request.startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const runRefreshStep = (): void => {
    if (closed) return;
    state = 'refreshing';
    const currentBatch = batch;
    const controller = new AbortController();
    activeController = controller;

    void Promise.all(currentBatch.map((id) => pullOne(id, controller.signal))).then((results) => {
      if (closed || controller.signal.aborted) return;
      activeController = undefined;
      snapshot = applyPullResults(snapshot, results);
      dirty = mergeDirty(dirty, results);
      failures = [...failures, ...pullFailures(results)];

      if (queue.length > 0) {
        batch = queue;
        queue = [];
        runRefreshStep();
        return;
      }

      const changedProviders = dirty;
      const batchFailures = failures;
      batch = [];
      dirty = [];
      failures = [];

      if (changedProviders.length > 0) {
        emitChanged(changedProviders);
      }
      for (const failure of batchFailures) {
        emitRefreshFailed(failure);
      }

      if (pingQueue.length > 0) {
        activePing = pingQueue[0];
        pingQueue = pingQueue.slice(1);
        runPingStep();
        return;
      }

      state = 'idle';
    });
  };

  const finishPingStep = (): void => {
    activePing = undefined;
    activeController = undefined;
    if (closed) return;
    if (pingQueue.length > 0) {
      activePing = pingQueue[0];
      pingQueue = pingQueue.slice(1);
      runPingStep();
      return;
    }
    if (queue.length > 0) {
      batch = queue;
      queue = [];
      dirty = [];
      failures = [];
      runRefreshStep();
      return;
    }
    state = 'idle';
  };

  const runPingStep = (): void => {
    if (closed || activePing === undefined) return;
    state = 'pinging';
    const currentPing = activePing;
    const controller = new AbortController();
    activeController = controller;
    const signals = [controller.signal];
    if (pingTimeoutMs !== undefined) {
      signals.push(AbortSignal.timeout(pingTimeoutMs));
    }
    const signal = AbortSignal.any(signals);

    void probeOne(currentPing, signal).then(
      (result) => {
        if (closed || currentPing.settled) return;
        activeController = undefined;
        const outcome: PingOutcome = {
          providerId: currentPing.providerId,
          modelId: currentPing.modelId,
          error: result.ok ? undefined : result.error,
        };
        const applied = applyPingOutcome(snapshot, outcome);
        snapshot = applied.snapshot;
        settlePing(currentPing, result);
        if (applied.changed) {
          emitChanged([currentPing.providerId]);
        }
        finishPingStep();
      },
      (error) => {
        if (closed || currentPing.settled) return;
        rejectPing(currentPing, error);
        finishPingStep();
      },
    );
  };

  const enqueueRefreshIds = (incoming: readonly string[]): void => {
    if (closed || incoming.length === 0) return;
    const uniqueIncoming = [...new Set(incoming)];
    if (state === 'idle') {
      batch = uniqueIncoming;
      queue = [];
      dirty = [];
      failures = [];
      runRefreshStep();
      return;
    }
    const active = new Set(state === 'refreshing' ? [...batch, ...queue] : queue);
    const additions = uniqueIncoming.filter((id) => !active.has(id));
    if (additions.length > 0) {
      queue = [...queue, ...additions];
    }
  };

  const enqueuePingRequest = (request: PingRequest): Promise<ProviderCatalogPingResult> => {
    if (closed) {
      return Promise.resolve({
        ok: false,
        durationMs: 0,
        error: 'Provider catalog is closed',
      });
    }
    const key = pingKey(request);
    const existing = pingTasks.get(key);
    if (existing !== undefined) return existing.promise;
    if (getModel(request.providerId, request.modelId) === undefined) {
      return Promise.reject(
        new Error(`Unknown model ${request.providerId}/${request.modelId}`),
      );
    }

    let resolvePromise: (result: ProviderCatalogPingResult) => void = () => {};
    let rejectPromise: (error: unknown) => void = () => {};
    const promise = new Promise<ProviderCatalogPingResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const task: PingTask = {
      ...request,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      startedAt: now(),
      settled: false,
    };
    pingTasks.set(key, task);
    if (state === 'idle') {
      activePing = task;
      runPingStep();
    } else {
      pingQueue = [...pingQueue, task];
    }
    return promise;
  };

  return {
    snapshot: () => snapshot,
    providers: () => Object.keys(snapshot.providers).toSorted(),
    providerInfo: (providerId) => snapshot.providers[providerId]?.info,
    models: (providerId) => listSnapshotModels(providerId, snapshot.providers[providerId]),
    model: getModel,
    requester: getRequester,
    upsert: (input) => {
      if (closed) return;
      const providerId = input.providerId ?? input.handle?.id;
      if (providerId === undefined) return;
      if (input.handle !== undefined) {
        handles.set(providerId, { ...input.handle, id: providerId });
      }
      snapshot = {
        providers: {
          ...snapshot.providers,
          [providerId]: {
            info: input.info,
            discovered: {},
            override: Object.fromEntries(
              (input.models ?? []).map((model) => [model.id, model]),
            ),
          },
        },
      };
      emitChanged([providerId]);
      if (input.handle !== undefined && input.refresh !== false) {
        enqueueRefreshIds([providerId]);
      }
    },
    bind: (handle) => {
      if (closed) return;
      handles.set(handle.id, handle);
    },
    remove: (providerId) => {
      if (closed) return;
      handles.delete(providerId);
      const providers = { ...snapshot.providers };
      delete providers[providerId];
      snapshot = { providers };
      emitChanged([providerId]);
    },
    refresh: (target) => {
      if (closed) return;
      const items = Array.isArray(target) ? target : [target];
      const ids: string[] = [];
      for (const item of items) {
        if (typeof item === 'string') {
          if (handles.has(item)) ids.push(item);
        } else {
          handles.set(item.id, item);
          ids.push(item.id);
        }
      }
      enqueueRefreshIds(ids);
    },
    ping: (providerId, modelId) => enqueuePingRequest({ providerId, modelId }),
    onChanged: (listener) => {
      changedListeners.add(listener);
      return () => {
        changedListeners.delete(listener);
      };
    },
    onRefreshFailed: (listener) => {
      failedListeners.add(listener);
      return () => {
        failedListeners.delete(listener);
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      activeController?.abort(new Error('Provider catalog is closed'));
      activeController = undefined;
      for (const task of pingTasks.values()) {
        settlePing(task, {
          ok: false,
          durationMs: now() - task.startedAt,
          error: 'Provider catalog is closed',
        });
      }
      handles.clear();
      changedListeners.clear();
      failedListeners.clear();
      batch = [];
      queue = [];
      dirty = [];
      failures = [];
      activePing = undefined;
      pingQueue = [];
      state = 'idle';
    },
  };
}
