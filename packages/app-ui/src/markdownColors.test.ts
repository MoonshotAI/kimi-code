import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(new URL('./markdown-tokens.css', import.meta.url), 'utf8');

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

it('keeps keyword and number syntax readable on both code surfaces', () => {
  const backgrounds = css.match(/--markdown-code-background: light-dark\((#[\da-f]{6}), (#[\da-f]{6})\)/)!;
  for (const role of ['keyword', 'number']) {
    const colors = css.match(new RegExp(`--markdown-syntax-${role}-color: light-dark\\((#[\\da-f]{6}), (#[\\da-f]{6})\\)`))!;
    expect(colors).not.toBeNull();
    for (const index of [1, 2]) {
      const foreground = luminance(colors[index]!);
      const background = luminance(backgrounds[index]!);
      expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  }
});
