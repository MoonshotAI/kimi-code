import { OSC11_RESPONSE } from '#/shared/terminal-constants';

import type { ResolvedTheme } from "./colors";

export function parseOsc11BackgroundTheme(data: string): ResolvedTheme | null {
  const match = OSC11_RESPONSE.exec(data);
  if (match === null) return null;
  const [, r, g, b] = match;
  if (r === undefined || g === undefined || b === undefined) return null;
  return themeFromHexChannels(r, g, b);
}

export function themeFromHexChannels(rHex: string, gHex: string, bHex: string): ResolvedTheme {
  const r = normalizeChannel(rHex);
  const g = normalizeChannel(gHex);
  const b = normalizeChannel(bHex);
  // Relative luminance, sRGB-linearised. Threshold 0.5 splits dark/light
  // backgrounds reliably for both pure-black (#000) and pure-white (#fff).
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 0.5 ? "light" : "dark";
}

function normalizeChannel(hex: string): number {
  // OSC 11 channels can be 1-4 hex digits. Scale into [0,1] regardless.
  const max = (1 << (hex.length * 4)) - 1;
  const value = parseInt(hex, 16);
  return Number.isFinite(value) ? value / max : 0;
}
