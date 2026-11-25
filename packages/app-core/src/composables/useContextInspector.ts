import { readonly, ref } from 'vue';

const contextInspectorEnabledState = ref(false);

export function setContextInspectorEnabled(enabled: boolean): void {
  contextInspectorEnabledState.value = enabled;
}

export function useContextInspector() {
  return {
    contextInspectorEnabled: readonly(contextInspectorEnabledState),
    setContextInspectorEnabled,
  };
}
