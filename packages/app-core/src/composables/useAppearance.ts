// app-core — appearance preferences (color scheme / font scale). Pure
// local UI state: only touches localStorage + the DOM, never the session
// state or the API. The values are module-level singletons so the whole app
// shares one instance.
//
// DOM writes (`documentElement` datasets / theme-color meta) are registered
// on the FIRST explicit `useAppearance()` call (gated by `started`), never at
// module top level — so importing this module has no side effects.
//
// localStorage is accessed through a tiny inline try/catch wrapper (the two
// keys below are owned solely by this module), so app-core does not import a
// consumer's storage module.

import { ref, watch } from 'vue';

/** Color scheme: 'light', 'dark', or follow the OS preference ('system'). */
export type ColorScheme = 'light' | 'dark' | 'system';

/** Font scale: four named steps, 'medium' (14px base) is the default. The
   stored value is the step NAME, never a px number — step names stay stable
   if a step's px is retuned. */
export type FontScale = 'small' | 'medium' | 'large' | 'xlarge';

const COLOR_SCHEME_VALUES: readonly string[] = ['light', 'dark', 'system'];
const FONT_SCALE_VALUES: readonly string[] = ['small', 'medium', 'large', 'xlarge'];
const FONT_SCALE_DEFAULT: FontScale = 'medium';

// Persisted keys owned by this module (mirror the host's `kimi-web.*`
// namespace so a host that previously stored these under the same names keeps
// its users' preferences across the move).
const KEY_COLOR_SCHEME = 'kimi-web.color-scheme';
const KEY_FONT_SCALE = 'kimi-web.font-scale';
// Superseded px-valued key (12–20); read once to migrate into KEY_FONT_SCALE.
const LEGACY_KEY_UI_FONT_SIZE = 'kimi-web.ui-font-size';

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

function storageRemove(key: string): void {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    // storage unavailable — ignore
  }
}

function loadColorScheme(): ColorScheme {
  const v = storageGet(KEY_COLOR_SCHEME);
  if (v && COLOR_SCHEME_VALUES.includes(v)) return v as ColorScheme;
  return 'system';
}

/** Page-background hex per scheme, used for the mobile browser-chrome
   <meta name="theme-color"> pins. Must mirror --color-bg in app-ui style.css
   (a computed-style read can't resolve the 'system' media split, so the two
   ends of the media query are pinned explicitly here). */
const SCHEME_BG = { light: '#ffffff', dark: '#121212' } as const;

function applyColorScheme(c: ColorScheme): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset['colorScheme'] = c;

  // Mobile browser chrome (status/address bar) follows <meta name=theme-color>.
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) return;
  const pinned = c === 'dark' ? SCHEME_BG.dark : c === 'light' ? SCHEME_BG.light : null;
  metas.forEach((meta) => {
    const media = meta.getAttribute('media') ?? '';
    const systemValue = media.includes('dark') ? SCHEME_BG.dark : SCHEME_BG.light;
    meta.setAttribute('content', pinned ?? systemValue);
  });
}

function isFontScale(v: string): v is FontScale {
  return FONT_SCALE_VALUES.includes(v);
}

/** Map a legacy px base size (12–20) onto the nearest named step. */
function pxToFontScale(px: number): FontScale {
  if (px <= 13) return 'small';
  if (px <= 15) return 'medium';
  if (px <= 17) return 'large';
  return 'xlarge';
}

function loadFontScale(): FontScale {
  const v = storageGet(KEY_FONT_SCALE);
  // 'xxlarge' was dropped from the scale; anyone who picked it lands on the
  // new top step instead of falling back to the default.
  if (v === 'xxlarge') return 'xlarge';
  if (v !== null) return isFontScale(v) ? v : FONT_SCALE_DEFAULT;
  const legacy = storageGet(LEGACY_KEY_UI_FONT_SIZE);
  if (legacy === null) return FONT_SCALE_DEFAULT;
  // A corrupt legacy value (NaN) migrates to the default, never to a random step.
  const px = Number(legacy);
  const migrated = Number.isFinite(px) ? pxToFontScale(px) : FONT_SCALE_DEFAULT;
  storageSet(KEY_FONT_SCALE, migrated);
  storageRemove(LEGACY_KEY_UI_FONT_SIZE);
  return migrated;
}

function applyFontScale(scale: FontScale): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset['fontScale'] = scale;
}

const colorScheme = ref<ColorScheme>(loadColorScheme());
const fontScale = ref<FontScale>(loadFontScale());

let started = false;
function startDomSync(): void {
  if (started) return;
  started = true;
  // `immediate` applies the loaded values to the DOM on this first explicit
  // call (not at module import); later changes propagate via the same watches.
  watch(colorScheme, applyColorScheme, { immediate: true });
  watch(fontScale, applyFontScale, { immediate: true });
}

function setColorScheme(c: ColorScheme): void {
  if (!COLOR_SCHEME_VALUES.includes(c)) return;
  colorScheme.value = c;
  storageSet(KEY_COLOR_SCHEME, c);
}

function setFontScale(scale: FontScale): void {
  if (!isFontScale(scale)) return;
  fontScale.value = scale;
  storageSet(KEY_FONT_SCALE, scale);
}

export function useAppearance() {
  startDomSync();
  return {
    colorScheme,
    fontScale,
    setColorScheme,
    setFontScale,
  };
}
