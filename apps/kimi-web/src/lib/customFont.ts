// apps/kimi-web/src/lib/customFont.ts
// Helpers for the custom font-family preference: the user types a font name
// (or comma-separated names) of locally installed fonts; we turn that into a
// safe CSS font-family list applied to a custom property.

/** CSS generic family keywords — matched case-insensitively, never quoted. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
]);

const MAX_INPUT_LENGTH = 200;

/**
 * Remove characters that could break out of a CSS declaration or quote pair
 * and cap the length. Applied at CSS-write time; the stored value stays the
 * raw user input so the input field round-trips what was typed.
 */
export function sanitizeCustomFontInput(input: string): string {
  return input.replace(/["'\\;{}<>]/g, '').slice(0, MAX_INPUT_LENGTH).trim();
}

/**
 * Convert user-typed text into a CSS font-family list: split on commas, trim,
 * collapse whitespace, quote each family (generic keywords pass through
 * unquoted, lowercased). Returns '' when nothing usable remains.
 */
export function toFontFamilyList(input: string): string {
  return sanitizeCustomFontInput(input)
    .split(',')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part.length > 0)
    .map((part) => (GENERIC_FAMILIES.has(part.toLowerCase()) ? part.toLowerCase() : `"${part}"`))
    .join(', ');
}
