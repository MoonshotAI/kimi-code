/**
 * Display-layer sanitizer for assistant-facing text.
 *
 * Circled/parenthesized digit glyphs (①-⑳ ❶-❿ ⓵-⓾ ⓪⓿) are East Asian
 * Ambiguous: CJK terminals render them double-width, so a line that mixes them
 * with single-width digits overlaps and garbles (upstream kimi-code #3302).
 * The width-mode fix (ambiguous_width) only helps when the terminal agrees;
 * when it doesn't, these glyphs are still visually fragile across fonts.
 * Displaying "1." instead never misaligns — the underlying transcript data is
 * untouched, this only rewrites what is painted.
 */

const CIRCLED_DIGIT_MAP: ReadonlyMap<number, string> = (() => {
  const map = new Map<number, string>();
  // ①-⑳ U+2460..U+2473 → 1..20 (circled)
  for (let i = 0; i < 20; i++) map.set(0x2460 + i, `${i + 1}.`);
  // ⑴-⒇ U+2474..U+2487 → 1..20 (parenthesized)
  for (let i = 0; i < 20; i++) map.set(0x2474 + i, `${i + 1}.`);
  // ⒈-⒛ U+2488..U+249B → 1..20 (digit + period glyph)
  for (let i = 0; i < 20; i++) map.set(0x2488 + i, `${i + 1}.`);
  // ⓵-⓾ U+24F5..U+24FE → 1..10 (double-circled)
  for (let i = 0; i < 10; i++) map.set(0x24f5 + i, `${i + 1}.`);
  // ❶-❿ U+2776..U+277F → 1..10 (dingbat negative circled)
  for (let i = 0; i < 10; i++) map.set(0x2776 + i, `${i + 1}.`);
  // ⓪ U+24EA, ⓿ U+24FF → 0.
  map.set(0x24ea, '0.');
  map.set(0x24ff, '0.');
  return map;
})();

/** Replace circled/parenthesized digit glyphs with "N." display forms. */
export function replaceCircledNumbers(text: string): string {
  // Fast path: bail before iterating code points.
  if (!/[①-⑳⑴-⒇⒈-⒛⓪⓵-⓾⓿❶-❿]/.test(text)) return text;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const replacement = CIRCLED_DIGIT_MAP.get(cp);
    out += replacement ?? ch;
  }
  return out;
}
