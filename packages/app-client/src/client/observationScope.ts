import { shallowRef } from 'vue';
import type { ReadRequestOptions } from '@moonshot-ai/app-core/api';

export function createObservationScope() {
  const current = shallowRef<{ key: string; controller: AbortController }>();
  const offscreen = new Map<string, AbortController>();

  function reset(): void {
    current.value?.controller.abort();
    current.value = undefined;
    for (const controller of offscreen.values()) controller.abort();
    offscreen.clear();
  }

  function activate(key: string | undefined): boolean {
    if (current.value?.key === key) return false;
    current.value?.controller.abort();
    current.value = undefined;
    if (key === undefined) return false;
    offscreen.get(key)?.abort();
    offscreen.delete(key);
    current.value = { key, controller: new AbortController() };
    return true;
  }

  function options(key: string): ReadRequestOptions {
    return {
      background: true,
      signal: current.value?.key === key ? current.value.controller.signal : AbortSignal.abort(),
    };
  }

  function offscreenOptions(key: string): ReadRequestOptions {
    if (current.value?.key === key) return options(key);
    let controller = offscreen.get(key);
    if (!controller) {
      controller = new AbortController();
      offscreen.set(key, controller);
    }
    return { background: true, signal: controller.signal };
  }

  function forget(key: string): void {
    if (current.value?.key === key) {
      current.value.controller.abort();
      current.value = undefined;
    }
    offscreen.get(key)?.abort();
    offscreen.delete(key);
  }

  return { activate, options, offscreenOptions, forget, reset };
}

export const sessionReadScope = createObservationScope();
export const workspaceReadScope = createObservationScope();

export function sessionObservationOptions(sessionId: string | undefined): ReadRequestOptions | undefined {
  return sessionId === undefined ? undefined : sessionReadScope.options(sessionId);
}

export function resetObservationScopes(): void {
  sessionReadScope.reset();
  workspaceReadScope.reset();
}
