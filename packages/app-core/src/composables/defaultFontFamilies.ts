import { isGenericFontFamily, quoteFontFamily, type FontTarget } from './useFontPrefs';

export type FontFamilyKind = 'font' | 'system-ui' | 'system-mono' | 'generic';

export type FontScript = 'latin' | 'cjk';

const SYSTEM_STACK_VARS: Record<FontTarget, string> = {
  ui: '--font-ui-system',
  transcript: '--font-ui-system',
  code: '--font-mono-system',
  terminal: '--font-mono-system',
};
const SYSTEM_UI_KEYWORDS = new Set(['-apple-system', 'blinkmacsystemfont', 'system-ui', 'ui-sans-serif']);
const SYSTEM_MONO_KEYWORDS = new Set(['ui-monospace']);
const PROBE_TEXT: Record<FontScript, string> = {
  latin: 'mmmmmmmmmmlli WQ@#0123',
  cjk: '永和九年岁在癸丑暮春之初',
};

export function fontFamilyKind(family: string): FontFamilyKind {
  const name = family.toLowerCase();
  if (SYSTEM_UI_KEYWORDS.has(name)) return 'system-ui';
  if (SYSTEM_MONO_KEYWORDS.has(name)) return 'system-mono';
  if (isGenericFontFamily(name)) return 'generic';
  return 'font';
}

export function parseFontFamilyList(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(',')) {
    const family = part.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (family !== '' && !out.some((seen) => seen.toLowerCase() === family.toLowerCase())) out.push(family);
  }
  return out;
}

function familyRenders(context: CanvasRenderingContext2D, family: string, script: FontScript): boolean {
  const text = PROBE_TEXT[script];
  for (const base of ['monospace', 'serif']) {
    context.font = `48px ${base}`;
    const fallback = context.measureText(text).width;
    context.font = `48px ${quoteFontFamily(family)}, ${base}`;
    if (context.measureText(text).width !== fallback) return true;
  }
  return false;
}

export function resolvePrimaryFontFamilies(
  stack: readonly string[],
  renders: (family: string, script: FontScript) => boolean,
): string[] {
  const candidates = stack.filter((family) => fontFamilyKind(family) !== 'generic');
  const latin = candidates.find((family) => renders(family, 'latin'));
  const cjk = candidates.find((family) => fontFamilyKind(family) === 'font' && renders(family, 'cjk'));
  const out: string[] = [];
  if (latin !== undefined) out.push(latin);
  if (cjk !== undefined && cjk !== latin) out.push(cjk);
  return out;
}

export function readSystemFontFamilies(target: FontTarget): string[] {
  if (typeof document === 'undefined' || !document.documentElement) return [];
  const stack = parseFontFamilyList(getComputedStyle(document.documentElement).getPropertyValue(SYSTEM_STACK_VARS[target]));
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement('canvas').getContext('2d');
  } catch {
    context = null;
  }
  if (context === null) return [];
  const ctx = context;
  return resolvePrimaryFontFamilies(stack, (family, script) => familyRenders(ctx, family, script));
}
