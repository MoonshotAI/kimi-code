import { OSC11_RESPONSE } from "#/tui/constant/terminal";

import type { ResolvedTheme } from "./colors";

export function parseOsc11Background(data: string): string | null {
  const match = OSC11_RESPONSE.exec(data);
  if (match === null) return null;
  const [, r, g, b] = match;
  if (r === undefined || g === undefined || b === undefined) return null;
  return `#${[r, g, b].map(channelByteHex).join("")}`;
}

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
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 0.5 ? "light" : "dark";
}

function channelByteHex(hex: string): string {
  return Math.round(normalizeChannel(hex) * 255).toString(16).padStart(2, "0").toUpperCase();
}

function normalizeChannel(hex: string): number {
  const max = (1 << (hex.length * 4)) - 1;
  const value = parseInt(hex, 16);
  return Number.isFinite(value) ? value / max : 0;
}
