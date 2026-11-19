
import { ref, watch } from 'vue';

export type ColorScheme = 'light' | 'dark' | 'system';

export type FontScale = 'small' | 'medium' | 'large' | 'xlarge';

const COLOR_SCHEME_VALUES: readonly string[] = ['light', 'dark', 'system'];
const FONT_SCALE_VALUES: readonly string[] = ['small', 'medium', 'large', 'xlarge'];
const FONT_SCALE_DEFAULT: FontScale = 'medium';

const KEY_COLOR_SCHEME = 'kimi-web.color-scheme';
const KEY_FONT_SCALE = 'kimi-web.font-scale';
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
  } catch {}
}

function storageRemove(key: string): void {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {}
}

function loadColorScheme(): ColorScheme {
  const v = storageGet(KEY_COLOR_SCHEME);
  if (v && COLOR_SCHEME_VALUES.includes(v)) return v as ColorScheme;
  return 'system';
}

const SCHEME_BG = { light: '#ffffff', dark: '#121212' } as const;

function applyColorScheme(c: ColorScheme): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset['colorScheme'] = c;

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

function pxToFontScale(px: number): FontScale {
  if (px <= 13) return 'small';
  if (px <= 15) return 'medium';
  if (px <= 17) return 'large';
  return 'xlarge';
}

function loadFontScale(): FontScale {
  const v = storageGet(KEY_FONT_SCALE);
  if (v === 'xxlarge') return 'xlarge';
  if (v !== null) return isFontScale(v) ? v : FONT_SCALE_DEFAULT;
  const legacy = storageGet(LEGACY_KEY_UI_FONT_SIZE);
  if (legacy === null) return FONT_SCALE_DEFAULT;
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
