import { effectScope, ref, watch } from 'vue';
import { loadBundledFonts } from './loadBundledFonts';

export type FontTarget = 'ui' | 'transcript' | 'code' | 'terminal';

export type FontMode = 'same' | 'system' | 'kimi' | 'custom';

export interface FontPrefs {
  mode: FontMode;
  families: string[];
  size: number | null;
}

export type FontPrefsMap = Record<FontTarget, FontPrefs>;

export const FONT_TARGETS: readonly FontTarget[] = ['ui', 'transcript', 'code', 'terminal'];
export const FONT_FOLLOWS: Partial<Record<FontTarget, FontTarget>> = { transcript: 'ui', terminal: 'code' };

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 32;
export const FONT_FAMILIES_MAX = 16;

export const DEFAULT_FONT_MODE: FontMode = 'kimi';

export function fontModes(target: FontTarget): FontMode[] {
  return FONT_FOLLOWS[target] === undefined ? ['kimi', 'system', 'custom'] : ['same', 'kimi', 'system', 'custom'];
}

export function defaultFontMode(target: FontTarget): FontMode {
  return FONT_FOLLOWS[target] === undefined ? DEFAULT_FONT_MODE : 'same';
}

export function defaultFontPrefs(target?: FontTarget): FontPrefs {
  return {
    mode: target === undefined ? DEFAULT_FONT_MODE : defaultFontMode(target),
    families: [],
    size: null,
  };
}

const KIMI_CODE_FAMILIES: Record<FontTarget, readonly string[]> = {
  ui: ['Schibsted Grotesk Variable', 'Noto Sans SC Variable'],
  transcript: ['Schibsted Grotesk Variable', 'Noto Sans SC Variable'],
  code: ['JetBrains Mono Variable'],
  terminal: ['JetBrains Mono Variable'],
};

export function kimiCodeFontFamilies(target: FontTarget): string[] {
  return [...KIMI_CODE_FAMILIES[target]];
}

export function systemFontKeyword(target: FontTarget): string {
  return target === 'code' || target === 'terminal' ? 'ui-monospace' : 'system-ui';
}

const KEY_FONT_PREFS = 'kimi-web.fonts';

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
    return;
  }
}

function sanitizeFamily(input: unknown): string {
  if (typeof input !== 'string') return '';
  const family = input.replace(/["\\]/g, '').trim().slice(0, 100);
  return family.toLowerCase() === '-apple-system' ? 'system-ui' : family;
}

const SYSTEM_FONT_KEYWORDS = new Set(['-apple-system', 'blinkmacsystemfont', 'system-ui', 'ui-sans-serif', 'ui-monospace']);

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'ui-serif',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

export function isGenericFontFamily(family: string): boolean {
  return GENERIC_FAMILIES.has(family.trim().toLowerCase());
}

function sanitizeFamilies(input: unknown, legacy: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof legacy === 'string' && legacy !== '' ? [legacy] : [];
  const out: string[] = [];
  for (const item of list) {
    const f = sanitizeFamily(item);
    if (isGenericFontFamily(f)) break;
    if (f !== '' && !out.includes(f)) out.push(f);
    if (out.length >= FONT_FAMILIES_MAX) break;
  }
  return out;
}

function sanitizeSize(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input)) return null;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(input)));
}

function sanitizeMode(raw: Record<string, unknown>, families: readonly string[], target?: FontTarget): FontMode {
  const followable = target === undefined || FONT_FOLLOWS[target] !== undefined;
  const mode = raw['mode'];
  if (mode === 'system' || mode === 'kimi' || mode === 'custom') return mode;
  if (mode === 'same') return followable ? 'same' : DEFAULT_FONT_MODE;
  if (followable && target !== undefined && raw['follow'] !== false) return 'same';
  return families.length === 0 ? DEFAULT_FONT_MODE : 'custom';
}

export function sanitizeFontPrefs(input: unknown, target?: FontTarget): FontPrefs {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const families = sanitizeFamilies(raw['families'], raw['family']);
  return {
    mode: sanitizeMode(raw, families, target),
    families,
    size: target === undefined || target === 'terminal' ? sanitizeSize(raw['size']) : null,
  };
}

function modeFamilies(target: FontTarget, prefs: FontPrefs): string[] {
  if (prefs.mode === 'kimi') return kimiCodeFontFamilies(target);
  if (prefs.mode === 'custom') return prefs.families;
  return [];
}

export function effectiveFontPrefs(map: FontPrefsMap, target: FontTarget): FontPrefs {
  const own = map[target];
  const source = FONT_FOLLOWS[target];
  if (source !== undefined && own.mode === 'same') {
    const from = map[source];
    return { ...own, families: modeFamilies(source, from) };
  }
  return { ...own, families: modeFamilies(target, own) };
}

const TARGET_VARS: Record<FontTarget, { family: string; size: string }> = {
  ui: { family: '--user-font-ui', size: '--base-font' },
  transcript: { family: '--user-font-transcript', size: '--user-transcript-size' },
  code: { family: '--user-font-mono', size: '--user-code-size' },
  terminal: { family: '--user-font-terminal', size: '--user-terminal-size' },
};

const SYSTEM_MONO_FAMILIES = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, "Cascadia Mono", Consolas';

export function quoteFontFamily(family: string): string {
  const name = family.toLowerCase();
  if (name === 'ui-monospace') return SYSTEM_MONO_FAMILIES;
  return SYSTEM_FONT_KEYWORDS.has(name) || GENERIC_FAMILIES.has(name) ? family : `"${family}"`;
}

export function fontCssVars(target: FontTarget, prefs: FontPrefs): [string, string][] {
  const v = TARGET_VARS[target];
  return [
    [v.family, prefs.families.length === 0 ? '' : prefs.families.map(quoteFontFamily).join(', ')],
    [v.size, target === 'terminal' && prefs.size !== null ? `${prefs.size}px` : ''],
  ];
}

function loadFontPrefs(): FontPrefsMap {
  let stored: unknown = null;
  const raw = storageGet(KEY_FONT_PREFS);
  if (raw !== null) {
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
  }
  const obj = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const map = {} as FontPrefsMap;
  for (const target of FONT_TARGETS) map[target] = sanitizeFontPrefs(obj[target], target);
  return map;
}

function applyFontPrefs(map: FontPrefsMap): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const style = document.documentElement.style;
  for (const target of FONT_TARGETS) {
    const prefs = effectiveFontPrefs(map, target);
    loadBundledFonts(prefs.families);
    for (const [name, value] of fontCssVars(target, prefs)) {
      if (value === '') style.removeProperty(name);
      else style.setProperty(name, value);
    }
  }
}

const fontPrefs = ref<FontPrefsMap>(loadFontPrefs());

let started = false;
function startDomSync(): void {
  if (started) return;
  started = true;
  effectScope(true).run(() => {
    watch(fontPrefs, applyFontPrefs, { immediate: true });
  });
  globalThis.addEventListener?.('storage', (event) => {
    if (event.key === KEY_FONT_PREFS) fontPrefs.value = loadFontPrefs();
  });
}

export function useFontPrefs() {
  startDomSync();

  function setFontPref(target: FontTarget, patch: Partial<FontPrefs>): void {
    const next: FontPrefsMap = {
      ...fontPrefs.value,
      [target]: sanitizeFontPrefs({ ...fontPrefs.value[target], ...patch }, target),
    };
    fontPrefs.value = next;
    storageSet(KEY_FONT_PREFS, JSON.stringify(next));
  }

  return { fontPrefs, setFontPref };
}
