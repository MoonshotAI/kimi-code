import { shallowRef } from 'vue';
import type { ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { getKimiWebApi } from '../client/deps';

export function createClientConfigLoader<T>(
  name: string,
  parse: (raw: unknown) => T,
) {
  const value = shallowRef<T>();
  let loadState: 'idle' | 'loading' | 'settled' = 'idle';
  let refreshFlight: {
    signal?: AbortSignal;
    background: boolean;
    promise: Promise<void>;
  } | null = null;
  let latestRequest: object | null = null;

  async function refresh(options?: ReadRequestOptions): Promise<void> {
    const signal = options?.signal;
    const background = options?.background ?? true;
    if (
      refreshFlight !== null &&
      refreshFlight.signal === signal &&
      refreshFlight.background === background &&
      signal?.aborted !== true
    ) {
      return refreshFlight.promise;
    }
    value.value = undefined;
    loadState = 'loading';
    const requestId = {};
    latestRequest = requestId;
    const request = (async () => {
      try {
        const raw = await getKimiWebApi().getClientConfig(name, options);
        if (latestRequest === requestId) value.value = raw === null ? undefined : parse(raw);
      } catch {
        if (latestRequest === requestId) value.value = undefined;
      }
    })();
    refreshFlight = { signal, background, promise: request };
    try {
      await request;
    } finally {
      if (latestRequest === requestId) loadState = 'settled';
      if (refreshFlight?.promise === request) refreshFlight = null;
    }
  }

  function needsLoad(): boolean {
    return value.value === undefined && loadState !== 'settled';
  }

  function reset(): void {
    value.value = undefined;
    loadState = 'idle';
    refreshFlight = null;
    latestRequest = null;
  }

  return { value, refresh, needsLoad, reset };
}
