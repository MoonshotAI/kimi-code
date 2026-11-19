export type FaviconInk = 'dark' | 'light';

const SAMPLE_SIZE = 32;
const CLEAR_ALPHA = 26;
const INK_ALPHA = 128;
const MIN_CLEAR_SHARE = 0.1;
const MAX_CHROMATIC_SHARE = 0.05;
const MIN_TONE_SHARE = 0.8;
const MAX_OPPOSITE_SHARE = 0.02;
const DARK_LUMINANCE = 0.08;
const LIGHT_LUMINANCE = 0.7;
const MIN_CHROMA = 26;
const MIN_SATURATION = 0.35;
const CACHE_LIMIT = 256;
const INLINE_IMAGE = /^data:image\//i;
const INLINE_SVG = /^data:image\/svg\+xml[;,]/i;
const BASE64_FLAG = /;\s*base64$/i;

const verdicts = new Map<string, FaviconInk | null>();

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function classifyFaviconPixels(rgba: ArrayLike<number>): FaviconInk | null {
  const pixels = rgba.length / 4;
  let clear = 0;
  let ink = 0;
  let chromatic = 0;
  let dark = 0;
  let light = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3]!;
    if (alpha < CLEAR_ALPHA) {
      clear++;
      continue;
    }
    if (alpha < INK_ALPHA) continue;
    ink++;
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    if (chroma > MIN_CHROMA && chroma / max > MIN_SATURATION) chromatic++;
    const tone = luminance(r, g, b);
    if (tone < DARK_LUMINANCE) dark++;
    else if (tone > LIGHT_LUMINANCE) light++;
  }
  if (ink === 0 || clear / pixels < MIN_CLEAR_SHARE || chromatic / ink > MAX_CHROMATIC_SHARE) return null;
  if (dark / ink >= MIN_TONE_SHARE && light / ink <= MAX_OPPOSITE_SHARE) return 'dark';
  if (light / ink >= MIN_TONE_SHARE && dark / ink <= MAX_OPPOSITE_SHARE) return 'light';
  return null;
}

function adaptsToColorScheme(src: string): boolean {
  if (!INLINE_SVG.test(src)) return false;
  const comma = src.indexOf(',');
  const body = src.slice(comma + 1);
  try {
    const markup = BASE64_FLAG.test(src.slice(0, comma)) ? atob(body) : decodeURIComponent(body);
    return /prefers-color-scheme/i.test(markup);
  } catch {
    return true;
  }
}

function sample(image: HTMLImageElement): FaviconInk | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return classifyFaviconPixels(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
  } catch {
    return null;
  }
}

export function knownFaviconInk(src: string): FaviconInk | null | undefined {
  return verdicts.get(src);
}

export function readFaviconInk(src: string, image: HTMLImageElement): FaviconInk | null {
  const known = verdicts.get(src);
  if (known !== undefined) return known;
  const ink = INLINE_IMAGE.test(src) && !adaptsToColorScheme(src) ? sample(image) : null;
  if (verdicts.size >= CACHE_LIMIT) verdicts.delete(verdicts.keys().next().value!);
  verdicts.set(src, ink);
  return ink;
}
