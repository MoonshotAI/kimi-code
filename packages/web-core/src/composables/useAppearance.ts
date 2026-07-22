// web-core — appearance preferences (color scheme / UI font size). Pure
// local UI state: only touches localStorage + the DOM, never the session
// state or the API. The values are module-level singletons so the whole app
// shares one instance.
//
// DOM writes (`documentElement` datasets / theme-color meta) are registered
// on the FIRST explicit `useAppearance()` call (gated by `started`), never at
// module top level — so importing this module has no side effects.
//
// localStorage is accessed through a tiny inline try/catch wrapper (the two
// keys below are owned solely by this module), so web-core does not import a
// consumer's storage module.

import { ref, watch } from 'vue';

/** Color scheme: 'light', 'dark', or follow the OS preference ('system'). */
export type ColorScheme = 'light' | 'dark' | 'system';

const COLOR_SCHEME_VALUES: readonly string[] = ['light', 'dark', 'system'];
const UI_FONT_SIZE_DEFAULT = 14;
const UI_FONT_SIZE_MIN = 12;
const UI_FONT_SIZE_MAX = 20;

// Persisted keys owned by this module (mirror the host's `kimi-web.*`
// namespace so a host that previously stored these under the same names keeps
// its users' preferences across the move).
const KEY_COLOR_SCHEME = 'kimi-web.color-scheme';
const KEY_UI_FONT_SIZE = 'kimi-web.ui-font-size';

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

function loadColorScheme(): ColorScheme {
  const v = storageGet(KEY_COLOR_SCHEME);
  if (v && COLOR_SCHEME_VALUES.includes(v)) return v as ColorScheme;
  return 'system';
}

function applyColorScheme(c: ColorScheme): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset['colorScheme'] = c;

  // Mobile browser chrome (status/address bar) follows <meta name=theme-color>.
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) return;
  const pinned = c === 'dark' ? '#0d1117' : c === 'light' ? '#ffffff' : null;
  metas.forEach((meta) => {
    const media = meta.getAttribute('media') ?? '';
    const systemValue = media.includes('dark') ? '#0d1117' : '#ffffff';
    meta.setAttribute('content', pinned ?? systemValue);
  });
}

function clampUiFontSize(value: number): number {
  if (!Number.isFinite(value)) return UI_FONT_SIZE_DEFAULT;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, Math.round(value)));
}

function loadUiFontSize(): number {
  const v = storageGet(KEY_UI_FONT_SIZE);
  return v === null ? UI_FONT_SIZE_DEFAULT : clampUiFontSize(Number(v));
}

function applyUiFontSize(value: number): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.style.setProperty('--base-ui-font-size', `${clampUiFontSize(value)}px`);
}

const colorScheme = ref<ColorScheme>(loadColorScheme());
const uiFontSize = ref<number>(loadUiFontSize());

let started = false;
function startDomSync(): void {
  if (started) return;
  started = true;
  // `immediate` applies the loaded values to the DOM on this first explicit
  // call (not at module import); later changes propagate via the same watches.
  watch(colorScheme, applyColorScheme, { immediate: true });
  watch(uiFontSize, applyUiFontSize, { immediate: true });
}

function setColorScheme(c: ColorScheme): void {
  if (!COLOR_SCHEME_VALUES.includes(c)) return;
  colorScheme.value = c;
  storageSet(KEY_COLOR_SCHEME, c);
}

function setUiFontSize(value: number): void {
  const next = clampUiFontSize(value);
  uiFontSize.value = next;
  storageSet(KEY_UI_FONT_SIZE, String(next));
}

export function useAppearance() {
  startDomSync();
  return {
    colorScheme,
    uiFontSize,
    setColorScheme,
    setUiFontSize,
  };
}
