/**
 * Color palette definitions for dark and light themes.
 *
 * `darkColors` / `lightColors` are the semantic `ColorPalette` consumed by
 * every UI component via the global Theme singleton. Each token holds its hex
 * value directly — see the per-token docs on `ColorPalette` for what each one
 * controls.
 *
 * Light palette values are tuned for ≥ 4.5:1 contrast against #FFFFFF
 * for text tokens and ≥ 3:1 for chrome (border / large text), matching
 * WCAG AA.
 */

// Each token below documents where it is actually consumed, so theme authors
// know what changing it affects. "Widely" means the token is read across most
// dialogs/messages rather than in one specific place.
export interface ColorPalette {
  // ── Brand ──
  /** Dominant interactive/brand colour: links & inline code, the selected item
   *  in nearly every dialog, the focused editor border, plan/"running" badges,
   *  spinners. The most widely used token. */
  primary: string;
  /** Secondary highlight: approval "▶" prefix, device-code box, image
   *  placeholder, BTW / queue panes, custom-registry import. */
  accent: string;

  // ── Text ──
  /** Default body text: dialog bodies, todo titles, footer model label,
   *  markdown headings, tool/read output, and assistant-side message bullets
   *  (assistant / tool / agent / read) plus markdown list bullets. */
  text: string;
  /** Emphasised / bold text: input dialogs, status messages. */
  textStrong: string;
  /** Secondary, dimmed text (the most widely used dim shade): thinking blocks,
   *  hints, descriptions, completed todos, markdown quotes, and the footer
   *  status bar (cwd path, git badge). */
  textDim: string;
  /** Faintest text: counters, scroll info, descriptions, markdown link URLs,
   *  code-block borders. */
  textMuted: string;

  // ── Surface ──
  /** Borders: pane & editor borders, markdown horizontal rule. */
  border: string;
  /** Focus / attention border — currently only the approval panel. */
  borderFocus: string;

  // ── State ──
  /** Success: ✓ marks, "enabled", completed states. */
  success: string;
  /** Warning: auto/yolo badges, stale markers, plan-mode hint. */
  warning: string;
  /** Error: error messages, failed tool output. */
  error: string;

  // ── Diff (all consumed by components/media/diff-preview.ts) ──
  /** Added lines. */
  diffAdded: string;
  /** Removed lines. */
  diffRemoved: string;
  /** Added lines — intra-line changed words (bold). */
  diffAddedStrong: string;
  /** Removed lines — intra-line changed words (bold). */
  diffRemovedStrong: string;
  /** Line-number gutter (also approval panel/preview). */
  diffGutter: string;
  /** Meta / hunk headers. */
  diffMeta: string;

  // ── Roles ──
  /** User message: bullet & text, skill-activation name. The one role colour
   *  with its own hue — assistant/thinking/status bullets reuse text/textDim. */
  roleUser: string;

  // ── Shell mode ──
  /** Shell mode (`!`): the `!` prompt symbol, bash-mode editor border, and the
   *  echoed `$ command` line. Its own hue (violet), distinct from
   *  plan-mode (primary) and the user role (roleUser). */
  shellMode: string;
}

export const darkColors: ColorPalette = {
  primary: '#4FA8FF',
  accent: '#5BC0BE',

  text: '#E0E0E0',
  textStrong: '#F5F5F5',
  textDim: '#888888',
  textMuted: '#6B6B6B',

  border: '#5A5A5A',
  borderFocus: '#E8A838',

  success: '#4EC87E',
  warning: '#E8A838',
  error: '#E85454',

  diffAdded: '#4EC87E',
  diffRemoved: '#E85454',
  diffAddedStrong: '#7AD99B',
  diffRemovedStrong: '#F08585',
  diffGutter: '#6B6B6B',
  diffMeta: '#888888',

  roleUser: '#FFCB6B',
  shellMode: '#BD93F9',
};

export const lightColors: ColorPalette = {
  primary: '#1565C0',
  accent: '#00838F',

  text: '#1A1A1A',
  textStrong: '#1A1A1A',
  textDim: '#454545',
  textMuted: '#5F5F5F',

  border: '#737373',
  borderFocus: '#92660A',

  success: '#0E7A38',
  warning: '#92660A',
  error: '#B91C1C',

  diffAdded: '#0E7A38',
  diffRemoved: '#B91C1C',
  diffAddedStrong: '#0E7A38',
  diffRemovedStrong: '#B91C1C',
  diffGutter: '#737373',
  diffMeta: '#5F5F5F',

  roleUser: '#9A4A00',
  shellMode: '#7C3AED',
};

/**
 * Fallback palettes for ANSI-16 terminals (chalk level 1, e.g. `TERM=xterm`).
 *
 * At that color depth `chalk.hex()` quantizes aggressively: mid grays below
 * `#808080` collapse to black (SGR 30, invisible on a dark background),
 * desaturated hues map to white, and gray never maps to bright black — so
 * several `darkColors` tokens become unreadable or lose their hue entirely.
 * These variants keep every token on a hex that quantizes to a readable,
 * hue-correct basic ANSI code; hue hierarchy is intentionally flatter than
 * the full palettes because 16 colors cannot express it.
 *
 * Values were verified against chalk's level-1 rgb→ansi16 conversion:
 * dark — neutrals land on SGR 37/97 (never 30), primary 94, accent 36,
 * success/diffAdded 32, error/diffRemoved 91, warning/roleUser 93,
 * shellMode 95; light — text tokens stay on 30, success/diffAdded 32,
 * warning/borderFocus/roleUser 33, error 31, shellMode 35.
 */
export const basicDarkColors: ColorPalette = {
  primary: '#5C5CFF', // → bright blue (dark #4FA8FF lands on bright cyan)
  accent: '#5BC0BE', // → cyan

  text: '#E0E0E0', // → white
  textStrong: '#FFFFFF', // → bright white
  textDim: '#C0C0C0', // → white
  textMuted: '#808080', // → white (#6B6B6B quantizes to black)

  border: '#808080', // → white (#5A5A5A quantizes to black)
  borderFocus: '#E8A838', // → bright yellow

  success: '#4EC87E', // → green
  warning: '#E8A838', // → bright yellow
  error: '#E85454', // → bright red

  diffAdded: '#4EC87E', // → green
  diffRemoved: '#E85454', // → bright red
  diffAddedStrong: '#00FF00', // → bright green (#7AD99B lands on cyan)
  diffRemovedStrong: '#FF5555', // → bright red (#F08585 lands on white)
  diffGutter: '#808080', // → white (#6B6B6B quantizes to black)
  diffMeta: '#888888', // → white

  roleUser: '#FFCB6B', // → bright yellow
  shellMode: '#FF00FF', // → bright magenta (#BD93F9 lands on white)
};

export const basicLightColors: ColorPalette = {
  primary: '#1565C0', // → blue
  accent: '#00838F', // → cyan

  text: '#1A1A1A', // → black
  textStrong: '#1A1A1A', // → black
  textDim: '#454545', // → black
  textMuted: '#5F5F5F', // → black

  border: '#737373', // → black
  borderFocus: '#808000', // → yellow (#92660A lands on red)

  success: '#008000', // → green (#0E7A38 quantizes to black)
  warning: '#808000', // → yellow (#92660A lands on red)
  error: '#B91C1C', // → red

  diffAdded: '#008000', // → green
  diffRemoved: '#B91C1C', // → red
  diffAddedStrong: '#008000', // → green
  diffRemovedStrong: '#B91C1C', // → red
  diffGutter: '#737373', // → black
  diffMeta: '#5F5F5F', // → black

  roleUser: '#808000', // → yellow (#9A4A00 lands on red)
  shellMode: '#800080', // → magenta (#7C3AED lands on bright blue)
};

export type ResolvedTheme = 'dark' | 'light';

/** Synchronous palette lookup for built-in themes only. */
export function getBuiltInPalette(resolved: ResolvedTheme): ColorPalette {
  return resolved === 'dark' ? darkColors : lightColors;
}

/** Synchronous ANSI-16 fallback palette lookup for built-in themes only. */
export function getBasicPalette(resolved: ResolvedTheme): ColorPalette {
  return resolved === 'dark' ? basicDarkColors : basicLightColors;
}
