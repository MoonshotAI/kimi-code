// apps/kimi-web/src/lib/fontCandidates.ts
// Candidate lists for the custom font dropdown + installed-font detection.
// The browser cannot enumerate installed fonts, so instead we probe a curated
// list of popular faces (CJK + Latin, UI + mono) with the classic canvas
// measureText trick: render a probe string in a generic base font, then again
// with the candidate prepended — a different advance width means the
// candidate actually rendered. Detection runs lazily on first use and is
// cached; it is never called at module scope, so importing this file in
// non-DOM (vitest node) environments is safe.

/** Popular UI / reading faces (sans, serif, and CJK print styles). */
export const UI_FONT_CANDIDATES: readonly string[] = [
  'PingFang SC',
  'Microsoft YaHei',
  'HarmonyOS Sans SC',
  'MiSans',
  'LXGW WenKai',
  'LXGW WenKai GB',
  'LXGW WenKai TC',
  'Smiley Sans',
  'Source Han Sans SC',
  'Noto Sans SC',
  'Source Han Serif SC',
  'Noto Serif SC',
  'Kaiti SC',
  'SimSun',
  'Roboto',
  'Open Sans',
  'Fira Sans',
  'IBM Plex Sans',
];

/** Popular monospace / coding faces. */
export const CODE_FONT_CANDIDATES: readonly string[] = [
  'Maple Mono NF CN',
  'Maple Mono',
  'Sarasa Mono SC',
  'Sarasa Term SC',
  'LXGW WenKai Mono',
  'Fira Code',
  'Cascadia Code',
  'Cascadia Mono',
  'JetBrains Mono',
  'SF Mono',
  'Menlo',
  'Consolas',
  'Monaco',
  'Hack',
  'Source Code Pro',
  'Ubuntu Mono',
  'IBM Plex Mono',
  'Intel One Mono',
  'Monaspace Neon',
  'Monaspace Argon',
];

// Mixed Latin + CJK probe: catches faces that only cover one script, and the
// letterform mix keeps metric-compatible faces from slipping through.
const PROBE = 'mmmmmmmmmmlli 中文测试 1lI0O0';
const BASE_FONTS = ['monospace', 'sans-serif'] as const;

let detectedCache: ReadonlySet<string> | null = null;

function measure(ctx: CanvasRenderingContext2D, font: string): number {
  ctx.font = `72px ${font}`;
  return ctx.measureText(PROBE).width;
}

/**
 * The subset of all candidates that appear to be installed locally. Returns
 * an empty set when there is no DOM (tests, SSR) or canvas is unavailable.
 */
export function detectInstalledFonts(): ReadonlySet<string> {
  if (detectedCache !== null) return detectedCache;
  const detected = new Set<string>();
  detectedCache = detected;
  if (typeof document === 'undefined') return detected;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return detected;
  const baseWidths = BASE_FONTS.map((base) => measure(ctx, base));
  for (const name of [...UI_FONT_CANDIDATES, ...CODE_FONT_CANDIDATES]) {
    const installed = BASE_FONTS.some(
      (base, i) => measure(ctx, `"${name}", ${base}`) !== baseWidths[i],
    );
    if (installed) detected.add(name);
  }
  return detected;
}

/** Candidates from the list that are installed, in curated order. */
export function installedCandidates(candidates: readonly string[]): string[] {
  const detected = detectInstalledFonts();
  return candidates.filter((name) => detected.has(name));
}
