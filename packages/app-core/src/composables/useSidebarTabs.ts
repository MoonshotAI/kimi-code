import { readonly, ref } from 'vue';
import { STORAGE_KEYS, safeGetString } from '../lib/storage';

const sidebarTabsState = ref<boolean>(safeGetString(STORAGE_KEYS.sidebarMultiTab) === '1');

export function setSidebarTabs(on: boolean): void {
  sidebarTabsState.value = on;
}

export function useSidebarTabs() {
  return {
    sidebarTabs: readonly(sidebarTabsState),
    setSidebarTabs,
  };
}
