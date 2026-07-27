/**
 * Terminal-title spinner styles (OSC 0).
 *
 * While the agent is busy, the terminal title is prefixed with an animated
 * glyph so progress stays visible on the terminal tab even when the window is
 * unfocused. The active style is resolved once from `KIMI_TITLE_SPINNER`
 * (default: `moon`).
 *
 * Each cycling style is a self-contained frame loop in `TITLE_SPINNER_STYLES`;
 * adding or removing a style only touches that registry. Two special ids are
 * not registry entries: `phase` maps the streaming phase to a static glyph
 * (no animation timer), and `off` restores the plain static title.
 */

export interface TitleSpinnerStyle {
  readonly frames: readonly string[];
  readonly interval: number;
}

export const TITLE_SPINNER_ENV = 'KIMI_TITLE_SPINNER';

export const DEFAULT_TITLE_SPINNER_ID = 'moon';
export const OFF_TITLE_SPINNER_ID = 'off';
export const PHASE_TITLE_SPINNER_ID = 'phase';

/** Cycling spinner styles. Entries are isolated; ordering is irrelevant. */
export const TITLE_SPINNER_STYLES: Readonly<Record<string, TitleSpinnerStyle>> = {
  moon: { frames: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'], interval: 120 },
  sparkle: { frames: ['✦', '✧', '✩', '✧'], interval: 180 },
  braille: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], interval: 80 },
  orbit: { frames: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'], interval: 100 },
  pulse: {
    frames: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂'],
    interval: 90,
  },
  line: { frames: ['|', '/', '-', '\\'], interval: 110 },
  hourglass: { frames: ['⧗', '⧖'], interval: 400 },
};

/** Glyph shown per streaming phase by the `phase` style (no animation timer). */
export const PHASE_TITLE_GLYPHS: Readonly<Record<string, string>> = {
  waiting: '◌',
  thinking: '✦',
  composing: '≋',
  shell: '▸',
};

/** Resolve a raw env value to a valid spinner id, falling back to the default. */
export function resolveTitleSpinnerId(raw: string | undefined): string {
  const id = raw?.trim().toLowerCase();
  if (id === OFF_TITLE_SPINNER_ID) return OFF_TITLE_SPINNER_ID;
  if (id === PHASE_TITLE_SPINNER_ID) return PHASE_TITLE_SPINNER_ID;
  // Own-property check only: an inherited key such as `constructor` or
  // `toString` must not be accepted as a style (its value has no `frames`).
  if (id !== undefined && Object.hasOwn(TITLE_SPINNER_STYLES, id)) return id;
  return DEFAULT_TITLE_SPINNER_ID;
}
