export interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export function mixColors(fromHex: string, toHex: string, ratio: number): string {
  return interpolateHexColor(
    requireHexColor(fromHex),
    requireHexColor(toHex),
    Math.min(1, Math.max(0, ratio)),
  );
}

export function colorDistance(fromHex: string, toHex: string): number {
  const from = requireHexColor(fromHex);
  const to = requireHexColor(toHex);
  return Math.hypot(from.red - to.red, from.green - to.green, from.blue - to.blue);
}

export function parseHexColor(hex: string): Rgb | undefined {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (match === null) return undefined;
  return {
    red: Number.parseInt(match[1]!, 16),
    green: Number.parseInt(match[2]!, 16),
    blue: Number.parseInt(match[3]!, 16),
  };
}

function requireHexColor(hex: string): Rgb {
  const color = parseHexColor(hex);
  if (color === undefined) throw new Error(`Invalid RGB color: ${hex}`);
  return color;
}

export function interpolateHexColor(from: Rgb, to: Rgb, ratio: number): string {
  const channel = (start: number, end: number): string =>
    Math.round(start + (end - start) * ratio).toString(16).padStart(2, '0');
  return `#${channel(from.red, to.red)}${channel(from.green, to.green)}${channel(from.blue, to.blue)}`;
}
