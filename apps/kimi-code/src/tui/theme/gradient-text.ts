import chalk from 'chalk';

import { interpolateHexColor, parseHexColor } from './color-mix';

export function gradientText(text: string, fromHex: string, toHex: string, accentBias = 1): string {
  const chars = Array.from(text);
  const from = parseHexColor(fromHex);
  const to = parseHexColor(toHex);
  if (chars.length <= 1 || from === undefined || to === undefined) {
    return chalk.hex(fromHex).bold(text);
  }
  const safeAccentBias = Number.isFinite(accentBias) ? Math.max(0, accentBias) : 1;
  return chars.map((char, index) => {
    const ratio = Math.min(1, (index / (chars.length - 1)) * safeAccentBias);
    return chalk.hex(interpolateHexColor(from, to, ratio)).bold(char);
  }).join('');
}
