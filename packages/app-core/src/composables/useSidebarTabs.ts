
import { ref } from 'vue';

const KEY_SIDEBAR_TABS = 'kimi-web.sidebar-multi-tab';

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {}
}

function loadSidebarTabs(): boolean {
  return storageGet(KEY_SIDEBAR_TABS) === '1';
}

const sidebarTabs = ref<boolean>(loadSidebarTabs());

function setSidebarTabs(on: boolean): void {
  sidebarTabs.value = on;
  storageSet(KEY_SIDEBAR_TABS, on ? '1' : '0');
}

export function useSidebarTabs() {
  return {
    sidebarTabs,
    setSidebarTabs,
  };
}
