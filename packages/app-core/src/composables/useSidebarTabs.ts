// app-core — "多标签页侧边栏" lab preference. Pure local UI state: only
// touches localStorage, never the session state or the API. The value is a
// module-level singleton so the whole app shares one instance.
//
// When OFF (the default) the sidebar renders the legacy single session list
// (open sessions only): no 进行中/已完成/工作空间 status tabs, no session-admin
// entry points, and the row action reads "归档" with the pre-status-tabs undo
// toast. When ON the sidebar shows the status-tabs view (open/done/workspaces)
// with the complete⇄reopen lifecycle.
//
// localStorage is accessed through a tiny inline try/catch wrapper (the key
// below is owned solely by this module), so app-core does not import a
// consumer's storage module — same rationale as useAppearance.

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
  } catch {
    // storage unavailable (private mode, quota, etc.) — ignore
  }
}

/** The lab toggle defaults OFF: the single-list sidebar stays the out-of-box
   experience until the user opts into the status-tabs view from Settings →
   实验室. Any stored value other than '1' reads as off. */
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
    /** True = status-tabs sidebar (open/done/workspaces + complete lifecycle);
        false = the legacy single session list with the archive action. */
    sidebarTabs,
    setSidebarTabs,
  };
}
