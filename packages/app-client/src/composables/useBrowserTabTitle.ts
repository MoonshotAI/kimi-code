import { ref } from 'vue';
import {
  DEFAULT_BROWSER_TAB_TITLE_SEGMENTS,
  formatBrowserTabTitleMode,
  loadBrowserTabTitleSegments,
  parseBrowserTabTitleSegments,
  saveBrowserTabTitleSegments,
  STORAGE_KEYS,
  type BrowserTabTitleMode,
  type BrowserTabTitleSegment,
  type BrowserTabTitleToken,
} from '@moonshot-ai/app-core/lib';

export {
  DEFAULT_BROWSER_TAB_TITLE_SEGMENTS,
  formatBrowserTabTitleMode,
  type BrowserTabTitleMode,
  type BrowserTabTitleSegment,
  type BrowserTabTitleToken,
};

const segments = ref<BrowserTabTitleSegment[]>(loadBrowserTabTitleSegments());

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEYS.browserTabTitle) {
      segments.value = parseBrowserTabTitleSegments(event.newValue);
    }
  });
}

function setSegments(next: readonly BrowserTabTitleSegment[]): void {
  saveBrowserTabTitleSegments(next);
  segments.value = loadBrowserTabTitleSegments();
}

function toggleSegment(id: BrowserTabTitleToken): void {
  setSegments(
    segments.value.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
  );
}

function moveSegment(id: BrowserTabTitleToken, toIndex: number): void {
  const list = [...segments.value];
  const fromIndex = list.findIndex((s) => s.id === id);
  if (fromIndex < 0) return;
  const clamped = Math.max(0, Math.min(list.length - 1, toIndex));
  if (fromIndex === clamped) return;
  const [moved] = list.splice(fromIndex, 1);
  if (!moved) return;
  list.splice(clamped, 0, moved);
  setSegments(list);
}

function reloadBrowserTabTitle(): void {
  segments.value = loadBrowserTabTitleSegments();
}

export function useBrowserTabTitle() {
  return {
    segments,
    setSegments,
    toggleSegment,
    moveSegment,
    reloadBrowserTabTitle,
  };
}
