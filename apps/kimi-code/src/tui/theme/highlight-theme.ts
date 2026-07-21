/**
 * Shared cli-highlight theme for code previews (Write/Edit tool calls,
 * approval panels) and markdown code blocks.
 *
 * cli-highlight's DEFAULT_THEME paints `string`, `regexp` and `deletion`
 * tokens red; reset exactly those tokens to `plain` so highlighted code
 * contains no red at all. Tokens not listed here fall back to DEFAULT_THEME.
 */

import { plain } from 'cli-highlight';
import type { Theme } from 'cli-highlight';

export const codeHighlightTheme: Theme = {
  string: plain,
  regexp: plain,
  deletion: plain,
};
