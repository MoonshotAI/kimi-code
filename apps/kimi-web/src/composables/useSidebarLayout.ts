// apps/kimi-web/src/composables/useSidebarLayout.ts
// Layout: resizable session column. ResizeHandle owns the column width (with
// localStorage persistence); we mirror it here to drive the App grid.

import { computed, ref } from 'vue';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../lib/storage';

const SIDEBAR_WIDTH_KEY = STORAGE_KEYS.sidebarWidth;
const SIDEBAR_COLLAPSED_KEY = STORAGE_KEYS.sidebarCollapsed;
const SIDEBAR_DEFAULT = 270;
const SIDEBAR_MIN = 170;
const SIDEBAR_COLLAPSED_WIDTH = 36;

export function useSidebarLayout() {
  const sessionColWidth = ref(SIDEBAR_DEFAULT);
  const sidebarCollapsed = ref(false);
  const sideWidth = computed(() =>
    sidebarCollapsed.value ? SIDEBAR_COLLAPSED_WIDTH : sessionColWidth.value,
  );

  function loadSidebarCollapsed(): void {
    try {
      sidebarCollapsed.value = safeGetString(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
      sidebarCollapsed.value = false;
    }
  }

  function saveSidebarCollapsed(): void {
    try {
      safeSetString(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed.value));
    } catch {
      // ignore
    }
  }

  function toggleSidebarCollapse(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value;
    saveSidebarCollapsed();
  }

  return {
    SIDEBAR_WIDTH_KEY,
    SIDEBAR_DEFAULT,
    SIDEBAR_MIN,
    sessionColWidth,
    sidebarCollapsed,
    sideWidth,
    loadSidebarCollapsed,
    toggleSidebarCollapse,
  };
}
