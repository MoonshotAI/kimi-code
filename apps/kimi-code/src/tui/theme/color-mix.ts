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

export function contrastRatio(firstHex: string, secondHex: string): number {
  const first = relativeLuminance(requireHexColor(firstHex));
  const second = relativeLuminance(requireHexColor(secondHex));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function relativeLuminance({ red, green, blue }: Rgb): number {
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
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
