import { ref } from 'vue';
import { STORAGE_KEYS, safeGetString, safeSetString } from '../lib/storage';

const sidebarTabs = ref<boolean>(safeGetString(STORAGE_KEYS.sidebarMultiTab) === '1');

function setSidebarTabs(on: boolean): void {
  sidebarTabs.value = on;
  safeSetString(STORAGE_KEYS.sidebarMultiTab, on ? '1' : '0');
}

export function useSidebarTabs() {
  return {
    sidebarTabs,
    setSidebarTabs,
  };
}
