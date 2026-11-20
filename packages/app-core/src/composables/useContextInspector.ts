import { ref } from 'vue';
import { STORAGE_KEYS, safeGetJson, safeSetJson } from '../lib/storage';

const contextInspectorEnabled = ref(safeGetJson<boolean>(STORAGE_KEYS.contextInspector) === true);

function setContextInspectorEnabled(enabled: boolean): void {
  contextInspectorEnabled.value = enabled;
  safeSetJson(STORAGE_KEYS.contextInspector, enabled);
}

export function useContextInspector() {
  return {
    contextInspectorEnabled,
    setContextInspectorEnabled,
  };
}
