
import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue';
import { safeGetString, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { PREVIEW_MIN } from './usePanelTabs';
import { clampPanelWidth, panelMaxWidth, useViewportWidth } from './useViewportWidth';

const SIDEBAR_WIDTH_KEY = STORAGE_KEYS.sidebarWidth;
const SIDEBAR_COLLAPSED_KEY = STORAGE_KEYS.sidebarCollapsed;
const SIDEBAR_DEFAULT = 270;
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 480;
const CONVERSATION_MIN = 320;

export interface UseSidebarLayoutOptions {
  previewOpen?: MaybeRefOrGetter<boolean>;
}

function readStoredWidth(): number {
  const raw = safeGetString(SIDEBAR_WIDTH_KEY);
  if (raw === null) return SIDEBAR_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? n : SIDEBAR_DEFAULT;
}

export function useSidebarLayout(options: UseSidebarLayoutOptions = {}) {
  const { viewportWidth } = useViewportWidth();
  const sessionColWidth = ref(readStoredWidth());
  const sidebarCollapsed = ref(safeGetString(SIDEBAR_COLLAPSED_KEY) === 'true');
  const sidebarDragging = ref(false);

  const sidebarMax = computed(() => {
    const reserve = CONVERSATION_MIN + (toValue(options.previewOpen) ? PREVIEW_MIN : 0);
    return Math.min(SIDEBAR_MAX, panelMaxWidth(viewportWidth.value, SIDEBAR_MIN, reserve));
  });

  const sideWidth = computed(() =>
    clampPanelWidth(sessionColWidth.value, SIDEBAR_MIN, sidebarMax.value),
  );

  const sidebarOccupiedWidth = computed(() => (sidebarCollapsed.value ? 0 : sideWidth.value));

  function saveSidebarCollapsed(): void {
    try {
      safeSetString(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed.value));
    } catch {}
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
    sidebarDragging,
    sideWidth,
    sidebarOccupiedWidth,
    toggleSidebarCollapse,
  };
}
