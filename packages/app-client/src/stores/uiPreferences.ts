import { ref } from 'vue';
import { defineStore } from 'pinia';
import { v4 as randomUUID } from 'uuid';
import { isDaemonApiError, isDaemonNetworkError, type AppUiPreferences } from '@moonshot-ai/app-core/api';
import { legacyUiPreferenceValues, uiPreferences, type UiPreferencesMode } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '../client/deps';
import { clientPinia } from './pinia';

export interface UiPreferencesHooks {
  pushOperationFailure: (operation: string, err: unknown) => void;
}

let uiPreferencesHooks: UiPreferencesHooks | null = null;

export function setUiPreferencesHooks(next: UiPreferencesHooks | null): void {
  uiPreferencesHooks = next;
}

interface BufferedEvent {
  readonly revision: number;
  readonly changed: Record<string, unknown>;
}

function isNotFound(error: unknown): boolean {
  return (isDaemonApiError(error) && error.code === 404) || (isDaemonNetworkError(error) && error.status === 404);
}

function isUnreachable(error: unknown): boolean {
  return isDaemonNetworkError(error) && error.status === undefined;
}

export const useUiPreferencesStore = defineStore('kimi.uiPreferences', () => {
  const mode = ref<UiPreferencesMode>(uiPreferences.mode);
  const synced = ref(!uiPreferences.bound || uiPreferences.mode === 'server');
  const clientId = randomUUID();
  let loading: Promise<void> | undefined;
  let buffered: BufferedEvent[] = [];
  let flushScheduled = false;
  let flushing: Promise<void> | undefined;

  uiPreferences.onChange(() => {
    mode.value = uiPreferences.mode;
  });
  uiPreferences.onQueued(() => scheduleFlush());

  async function fetchSnapshot(): Promise<AppUiPreferences> {
    const api = getKimiWebApi();
    const snapshot = await api.getUiPreferences();
    if (uiPreferences.imported && snapshot.revision > 0) return snapshot;
    const legacy = legacyUiPreferenceValues();
    if (Object.keys(legacy).length === 0) {
      uiPreferences.markImported();
      return snapshot;
    }
    await api.importUiPreferences(legacy, clientId);
    uiPreferences.markImported();
    return api.getUiPreferences();
  }

  async function load(): Promise<void> {
    try {
      const snapshot = await fetchSnapshot();
      uiPreferences.applySnapshot(snapshot);
      for (const event of buffered) uiPreferences.applyEvent(event.revision, event.changed);
    } catch (error) {
      if (isNotFound(error)) uiPreferences.fallBackToLocal();
      else if (!isUnreachable(error)) uiPreferencesHooks?.pushOperationFailure('loadUiPreferences', error);
    } finally {
      buffered = [];
      synced.value = true;
    }
    if (uiPreferences.hasQueued()) scheduleFlush();
  }

  function refresh(): Promise<void> {
    if (!uiPreferences.bound) return Promise.resolve();
    loading ??= load().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  function applyServerEvent(revision: number, changed: Record<string, unknown>): void {
    if (loading !== undefined) {
      buffered.push({ revision, changed });
      return;
    }
    if (uiPreferences.applyEvent(revision, changed) === 'behind') void refresh();
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      void flush();
    });
  }

  async function flush(): Promise<void> {
    await flushing;
    await loading;
    if (uiPreferences.mode !== 'server' || !uiPreferences.hasQueued()) return;
    const ops = uiPreferences.takeQueued();
    flushing = send(ops).finally(() => {
      flushing = undefined;
    });
    await flushing;
  }

  async function send(ops: ReturnType<typeof uiPreferences.takeQueued>): Promise<void> {
    try {
      const result = await getKimiWebApi().patchUiPreferences(ops, clientId);
      if (uiPreferences.settle(ops, result.changed)) void refresh();
    } catch (error) {
      if (isUnreachable(error)) {
        uiPreferences.requeue(ops);
        return;
      }
      uiPreferences.settle(ops, undefined);
      if (isNotFound(error)) {
        uiPreferences.fallBackToLocal();
        return;
      }
      uiPreferencesHooks?.pushOperationFailure('saveUiPreferences', error);
      void refresh();
      return;
    }
    if (uiPreferences.hasQueued()) scheduleFlush();
  }

  return {
    mode,
    synced,
    refresh,
    applyServerEvent,
    flush,
  };
});

export function uiPreferencesStore() {
  return useUiPreferencesStore(clientPinia);
}
