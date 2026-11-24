import { computed, ref } from 'vue';
import { STORAGE_KEYS, safeGetJson, safeSetJson } from '../lib/storage';

const storedContextInspectorEnabled = ref(
  safeGetJson<boolean>(STORAGE_KEYS.contextInspector) === true,
);
const contextInspectorBetaOverride = ref(false);
const contextInspectorEnabled = computed(
  () => contextInspectorBetaOverride.value || storedContextInspectorEnabled.value,
);

function setContextInspectorEnabled(enabled: boolean): void {
  storedContextInspectorEnabled.value = enabled;
  safeSetJson(STORAGE_KEYS.contextInspector, enabled);
}

export function setContextInspectorBetaOverride(enabled: boolean): void {
  contextInspectorBetaOverride.value = enabled;
}

export function useContextInspector() {
  return {
    contextInspectorEnabled,
    storedContextInspectorEnabled,
    setContextInspectorEnabled,
  };
}
