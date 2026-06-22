// apps/kimi-web/src/composables/useSidebarLayout.ts
// Layout: resizable session column. ResizeHandle owns the column width (with
// localStorage persistence); we mirror it here to drive the App grid.

import { computed, ref } from 'vue';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../lib/storage';
import { clampPanelWidth, panelMaxWidth, useViewportWidth } from './useViewportWidth';

const SIDEBAR_WIDTH_KEY = STORAGE_KEYS.sidebarWidth;
const SIDEBAR_COLLAPSED_KEY = STORAGE_KEYS.sidebarCollapsed;
const SIDEBAR_DEFAULT = 270;
const SIDEBAR_MIN = 170;
const SIDEBAR_COLLAPSED_WIDTH = 36;
// Minimum width kept for the conversation pane. The sidebar is capped so the
// conversation keeps at least this much room, which also guarantees the sidebar
// resize handle and collapse button stay inside the viewport even when a width
// saved on a wider display is restored on a narrower one.
const CONVERSATION_MIN = 320;

export function useSidebarLayout() {
  const { viewportWidth } = useViewportWidth();
  const sessionColWidth = ref(SIDEBAR_DEFAULT);
  const sidebarCollapsed = ref(false);

  // Largest sidebar width that still leaves the conversation pane usable.
  const sidebarMax = computed(() =>
    panelMaxWidth(viewportWidth.value, SIDEBAR_MIN, CONVERSATION_MIN),
  );

  const sideWidth = computed(() =>
    sidebarCollapsed.value
      ? SIDEBAR_COLLAPSED_WIDTH
      : clampPanelWidth(sessionColWidth.value, SIDEBAR_MIN, sidebarMax.value),
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
    sidebarMax,
    sessionColWidth,
    sidebarCollapsed,
    sideWidth,
    loadSidebarCollapsed,
    toggleSidebarCollapse,
  };
}
