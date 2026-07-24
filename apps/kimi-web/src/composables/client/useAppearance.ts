// apps/kimi-web/src/composables/client/useAppearance.ts
// Appearance preferences (color scheme / accent / UI font size / UI & code
// font family) and the streaming "fast moon" spinner state. Pure local UI
// state: only touches storage + the DOM, never rawState or the API. The values
// are module-level singletons so the whole app shares one instance.

import { ref, watch } from 'vue';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';
import { toFontFamilyList } from '../../lib/customFont';

/** Color scheme: 'light', 'dark', or follow the OS preference ('system'). */
export type ColorScheme = 'light' | 'dark' | 'system';

/** Accent: 'blue' (Kimi blue, default) or 'mono' (black/white). */
export type Accent = 'blue' | 'mono';

/**
 * UI font family: 'default' (Inter-first stack), 'system' (platform UI
 * stack), 'serif' (reading-oriented serif stack), or 'custom' (user-provided
 * locally installed font names). Mirrored onto
 * <html data-ui-font-family>; CSS remaps --font-ui for the non-default values.
 */
export type UiFontFamily = 'default' | 'system' | 'serif' | 'custom';

/**
 * Code font family: 'default' (JetBrains Mono-first stack), 'system'
 * (platform monospace stack), or 'custom' (user-provided locally installed
 * font names). Mirrored onto <html data-code-font-family>; CSS remaps
 * --font-mono for the non-default values.
 */
export type CodeFontFamily = 'default' | 'system' | 'custom';

const ACCENT_VALUES: readonly string[] = ['blue', 'mono'];
const COLOR_SCHEME_VALUES: readonly string[] = ['light', 'dark', 'system'];
const UI_FONT_FAMILY_VALUES: readonly string[] = ['default', 'system', 'serif', 'custom'];
const CODE_FONT_FAMILY_VALUES: readonly string[] = ['default', 'system', 'custom'];
const UI_FONT_SIZE_DEFAULT = 14;
const UI_FONT_SIZE_MIN = 12;
const UI_FONT_SIZE_MAX = 20;

function loadAccent(): Accent {
  const v = safeGetString(STORAGE_KEYS.accent);
  if (v && ACCENT_VALUES.includes(v)) return v as Accent;
  return 'blue';
}

function applyAccent(a: Accent): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.accent = a;
}

function loadColorScheme(): ColorScheme {
  const v = safeGetString(STORAGE_KEYS.colorScheme);
  if (v && COLOR_SCHEME_VALUES.includes(v)) return v as ColorScheme;
  return 'system';
}

function applyColorScheme(c: ColorScheme): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.colorScheme = c;

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
  const v = safeGetString(STORAGE_KEYS.uiFontSize);
  return v === null ? UI_FONT_SIZE_DEFAULT : clampUiFontSize(Number(v));
}

function applyUiFontSize(value: number): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.style.setProperty('--base-ui-font-size', `${clampUiFontSize(value)}px`);
}

function loadUiFontFamily(): UiFontFamily {
  const v = safeGetString(STORAGE_KEYS.uiFontFamily);
  if (v && UI_FONT_FAMILY_VALUES.includes(v)) return v as UiFontFamily;
  return 'default';
}

function applyUiFontFamily(f: UiFontFamily): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.uiFontFamily = f;
}

function loadCodeFontFamily(): CodeFontFamily {
  const v = safeGetString(STORAGE_KEYS.codeFontFamily);
  if (v && CODE_FONT_FAMILY_VALUES.includes(v)) return v as CodeFontFamily;
  return 'default';
}

function applyCodeFontFamily(f: CodeFontFamily): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.codeFontFamily = f;
}

// Custom font names are stored raw (so the input field round-trips what the
// user typed) and sanitized into a CSS font-family list only when written to
// the custom property. The matching default stack is appended so a typo'd or
// uninstalled name degrades to the default face instead of the browser's
// generic fallback. An empty/unusable value removes the property so the CSS
// fallback chain takes over.
function applyCustomFontProperty(property: string, fallbackProperty: string, rawName: string): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const list = toFontFamilyList(rawName);
  if (list) document.documentElement.style.setProperty(property, `${list}, var(${fallbackProperty})`);
  else document.documentElement.style.removeProperty(property);
}

const colorScheme = ref<ColorScheme>(loadColorScheme());
const accent = ref<Accent>(loadAccent());
const uiFontSize = ref<number>(loadUiFontSize());
const uiFontFamily = ref<UiFontFamily>(loadUiFontFamily());
const uiCustomFont = ref<string>(safeGetString(STORAGE_KEYS.uiCustomFont) ?? '');
const codeFontFamily = ref<CodeFontFamily>(loadCodeFontFamily());
const codeCustomFont = ref<string>(safeGetString(STORAGE_KEYS.codeCustomFont) ?? '');

watch(colorScheme, applyColorScheme, { immediate: true });
watch(accent, applyAccent, { immediate: true });
watch(uiFontSize, applyUiFontSize, { immediate: true });
watch(uiFontFamily, applyUiFontFamily, { immediate: true });
watch(uiCustomFont, (name) => applyCustomFontProperty('--font-ui-custom', '--font-ui-default', name), {
  immediate: true,
});
watch(codeFontFamily, applyCodeFontFamily, { immediate: true });
watch(codeCustomFont, (name) => applyCustomFontProperty('--font-mono-custom', '--font-mono-default', name), {
  immediate: true,
});

function setColorScheme(c: ColorScheme): void {
  if (!COLOR_SCHEME_VALUES.includes(c)) return;
  colorScheme.value = c;
  safeSetString(STORAGE_KEYS.colorScheme, c);
}

function setAccent(a: Accent): void {
  if (!ACCENT_VALUES.includes(a)) return;
  accent.value = a;
  safeSetString(STORAGE_KEYS.accent, a);
}

function setUiFontSize(value: number): void {
  const next = clampUiFontSize(value);
  uiFontSize.value = next;
  safeSetString(STORAGE_KEYS.uiFontSize, String(next));
}

function setUiFontFamily(f: UiFontFamily): void {
  if (!UI_FONT_FAMILY_VALUES.includes(f)) return;
  uiFontFamily.value = f;
  safeSetString(STORAGE_KEYS.uiFontFamily, f);
}

function setUiCustomFont(name: string): void {
  uiCustomFont.value = name;
  safeSetString(STORAGE_KEYS.uiCustomFont, name);
}

function setCodeFontFamily(f: CodeFontFamily): void {
  if (!CODE_FONT_FAMILY_VALUES.includes(f)) return;
  codeFontFamily.value = f;
  safeSetString(STORAGE_KEYS.codeFontFamily, f);
}

function setCodeCustomFont(name: string): void {
  codeCustomFont.value = name;
  safeSetString(STORAGE_KEYS.codeCustomFont, name);
}

// CSS handles the moon frames; this only flips the spinner between normal and
// fast classes when the active session is visibly producing content quickly.
const MOON_FAST_WINDOW_MS = 600;
const MOON_FAST_MIN_ELAPSED_MS = 250;
const MOON_FAST_CHECK_INTERVAL_MS = 250;
const MOON_FAST_HOLD_MS = 1000;
const MOON_FAST_CHARS_PER_SECOND = 160;

type MoonSpeedSample = { time: number; chars: number };

const fastMoon = ref(false);
let moonSpeedSamples: MoonSpeedSample[] = [];
let moonFastResetTimer: ReturnType<typeof setTimeout> | null = null;
let lastMoonFastCheckAt = -MOON_FAST_CHECK_INTERVAL_MS;

function resetFastMoon(): void {
  moonSpeedSamples = [];
  lastMoonFastCheckAt = -MOON_FAST_CHECK_INTERVAL_MS;
  fastMoon.value = false;
  if (moonFastResetTimer !== null) {
    clearTimeout(moonFastResetTimer);
    moonFastResetTimer = null;
  }
}

function holdFastMoon(): void {
  fastMoon.value = true;
  if (moonFastResetTimer !== null) clearTimeout(moonFastResetTimer);
  moonFastResetTimer = setTimeout(() => {
    moonFastResetTimer = null;
    moonSpeedSamples = [];
    lastMoonFastCheckAt = -MOON_FAST_CHECK_INTERVAL_MS;
    fastMoon.value = false;
  }, MOON_FAST_HOLD_MS);
}

function recordMoonDelta(chars: number): void {
  if (chars <= 0) return;
  const now = Date.now();
  moonSpeedSamples.push({ time: now, chars });
  const cutoff = now - MOON_FAST_WINDOW_MS;
  moonSpeedSamples = moonSpeedSamples.filter((s) => s.time >= cutoff);

  if (now - lastMoonFastCheckAt < MOON_FAST_CHECK_INTERVAL_MS) return;
  lastMoonFastCheckAt = now;

  const oldest = moonSpeedSamples[0]?.time ?? now;
  const elapsed = Math.max(now - oldest, MOON_FAST_MIN_ELAPSED_MS);
  const totalChars = moonSpeedSamples.reduce((sum, s) => sum + s.chars, 0);
  const charsPerSecond = (totalChars / elapsed) * 1000;
  if (charsPerSecond >= MOON_FAST_CHARS_PER_SECOND) holdFastMoon();
}

export function useAppearance() {
  return {
    colorScheme,
    accent,
    uiFontSize,
    uiFontFamily,
    uiCustomFont,
    codeFontFamily,
    codeCustomFont,
    fastMoon,
    setColorScheme,
    setAccent,
    setUiFontSize,
    setUiFontFamily,
    setUiCustomFont,
    setCodeFontFamily,
    setCodeCustomFont,
    resetFastMoon,
    recordMoonDelta,
  };
}
