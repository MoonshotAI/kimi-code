import { readonly, ref } from 'vue';
import { STORAGE_KEYS, safeGetJson } from '../lib/storage';

const contextInspectorEnabledState = ref(
  safeGetJson<boolean>(STORAGE_KEYS.contextInspector) === true,
);

export function setContextInspectorEnabled(enabled: boolean): void {
  contextInspectorEnabledState.value = enabled;
}

export function useContextInspector() {
  return {
    contextInspectorEnabled: readonly(contextInspectorEnabledState),
    setContextInspectorEnabled,
  };
}
