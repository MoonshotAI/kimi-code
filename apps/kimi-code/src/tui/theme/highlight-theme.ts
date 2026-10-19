/**
 * Shared cli-highlight theme for code previews (Write/Edit tool calls,
 * approval panels) and markdown code blocks.
 *
 * cli-highlight's DEFAULT_THEME paints `string` and `regexp` tokens red;
 * reset exactly those tokens to `plain` so highlighted code contains no red.
 * Diff `addition` and `deletion` tokens map to the palette's diff colors
 * instead, so diff fences and diff previews follow the active palette and
 * match the Edit-tool diff styling. Tokens not listed here fall back to
 * DEFAULT_THEME.
 */

import { plain } from 'cli-highlight';
import type { Theme } from 'cli-highlight';

import { currentTheme } from './theme';

export const codeHighlightTheme: Theme = {
  string: plain,
  regexp: plain,
  addition: (code) => currentTheme.fg('diffAdded', code),
  deletion: (code) => currentTheme.fg('diffRemoved', code),
};
