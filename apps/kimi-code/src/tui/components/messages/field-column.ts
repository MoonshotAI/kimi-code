/**
 * Display-width-aware padding for the aligned label columns shared by the
 * `/usage` and `/status` panels.
 *
 * `String.padEnd` pads by code-point count, which misaligns columns once a
 * value contains double-width characters (CJK labels render two cells wide but
 * count as one code point). Padding by *visible* width keeps the value column
 * aligned regardless of locale.
 */

import { visibleWidth } from '@earendil-works/pi-tui';

/** Pad `text` with trailing spaces until it occupies `width` display columns. */
export function padEndToWidth(text: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(text));
  return text + ' '.repeat(pad);
}
