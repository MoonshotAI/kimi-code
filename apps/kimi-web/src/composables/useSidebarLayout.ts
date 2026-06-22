// apps/kimi-web/src/composables/useSidebarLayout.ts
// Layout: resizable session column. ResizeHandle owns the column width (with
// localStorage persistence); we mirror it here to drive the App grid.

import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../lib/storage';
import { PREVIEW_MIN } from './useDetailPanel';
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

export interface UseSidebarLayoutOptions {
  /** True while the right-side detail/preview panel is open, so the sidebar
   *  reserves room for it in addition to the conversation pane. */
  previewOpen?: MaybeRefOrGetter<boolean>;
}

export function useSidebarLayout(options: UseSidebarLayoutOptions = {}) {
  const { viewportWidth } = useViewportWidth();
  const sessionColWidth = ref(SIDEBAR_DEFAULT);
  const sidebarCollapsed = ref(false);

  // Largest sidebar width that still leaves the conversation pane usable. When
  // the right-side panel is open, also reserves its minimum width so the
  // conversation column can never be squeezed to nothing.
  const sidebarMax = computed(() => {
    const reserve = CONVERSATION_MIN + (toValue(options.previewOpen) ? PREVIEW_MIN : 0);
    return panelMaxWidth(viewportWidth.value, SIDEBAR_MIN, reserve);
  });

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
