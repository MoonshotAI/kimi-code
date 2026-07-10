// apps/kimi-web/src/composables/client/useAppearance.ts
// Appearance preferences (color scheme / accent / UI font size) and the
// streaming "fast moon" spinner state. Pure local UI state: only touches
// storage + the DOM, never rawState or the API. The values are module-level
// singletons so the whole app shares one instance.

import { ref, watch } from 'vue';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';

/** Color scheme: 'light', 'dark', or follow the OS preference ('system'). */
export type ColorScheme = 'light' | 'dark' | 'system';

/** Accent: 'blue' (Kimi blue, default) or 'mono' (black/white). */
export type Accent = 'blue' | 'mono';

const ACCENT_VALUES: readonly string[] = ['blue', 'mono'];
const COLOR_SCHEME_VALUES: readonly string[] = ['light', 'dark', 'system'];
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

const colorScheme = ref<ColorScheme>(loadColorScheme());
const accent = ref<Accent>(loadAccent());
const uiFontSize = ref<number>(loadUiFontSize());

watch(colorScheme, applyColorScheme, { immediate: true });
watch(accent, applyAccent, { immediate: true });
watch(uiFontSize, applyUiFontSize, { immediate: true });

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
    fastMoon,
    setColorScheme,
    setAccent,
    setUiFontSize,
    resetFastMoon,
    recordMoonDelta,
  };
}
