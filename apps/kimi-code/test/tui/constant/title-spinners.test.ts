import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TITLE_SPINNER_ID,
  OFF_TITLE_SPINNER_ID,
  PHASE_TITLE_GLYPHS,
  PHASE_TITLE_SPINNER_ID,
  resolveTitleSpinnerId,
  TITLE_SPINNER_STYLES,
} from '#/tui/constant/title-spinners';

describe('resolveTitleSpinnerId', () => {
  it('returns a registered style id unchanged', () => {
    for (const id of Object.keys(TITLE_SPINNER_STYLES)) {
      expect(resolveTitleSpinnerId(id)).toBe(id);
    }
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(resolveTitleSpinnerId('  MOON ')).toBe('moon');
    expect(resolveTitleSpinnerId('Braille')).toBe('braille');
  });

  it('accepts the special off and phase ids', () => {
    expect(resolveTitleSpinnerId('off')).toBe(OFF_TITLE_SPINNER_ID);
    expect(resolveTitleSpinnerId('PHASE')).toBe(PHASE_TITLE_SPINNER_ID);
  });

  it('falls back to the default for unknown or empty values', () => {
    expect(resolveTitleSpinnerId(undefined)).toBe(DEFAULT_TITLE_SPINNER_ID);
    expect(resolveTitleSpinnerId('')).toBe(DEFAULT_TITLE_SPINNER_ID);
    expect(resolveTitleSpinnerId('   ')).toBe(DEFAULT_TITLE_SPINNER_ID);
    expect(resolveTitleSpinnerId('nope')).toBe(DEFAULT_TITLE_SPINNER_ID);
  });

  it('default id is a registered style', () => {
    expect(TITLE_SPINNER_STYLES[DEFAULT_TITLE_SPINNER_ID]).toBeDefined();
  });

  it('rejects inherited object keys instead of treating them as styles', () => {
    expect(resolveTitleSpinnerId('constructor')).toBe(DEFAULT_TITLE_SPINNER_ID);
    expect(resolveTitleSpinnerId('toString')).toBe(DEFAULT_TITLE_SPINNER_ID);
    expect(resolveTitleSpinnerId('hasOwnProperty')).toBe(DEFAULT_TITLE_SPINNER_ID);
    expect(resolveTitleSpinnerId('__proto__')).toBe(DEFAULT_TITLE_SPINNER_ID);
  });
});

describe('TITLE_SPINNER_STYLES', () => {
  it('every style has at least two non-empty frames and a positive interval', () => {
    for (const [id, style] of Object.entries(TITLE_SPINNER_STYLES)) {
      expect(style.frames.length, id).toBeGreaterThanOrEqual(2);
      for (const frame of style.frames) {
        expect(frame.length, id).toBeGreaterThan(0);
      }
      expect(style.interval, id).toBeGreaterThan(0);
    }
  });
});

describe('PHASE_TITLE_GLYPHS', () => {
  it('every busy phase maps to a non-empty glyph', () => {
    for (const phase of ['waiting', 'thinking', 'composing', 'shell']) {
      expect(PHASE_TITLE_GLYPHS[phase]?.length, phase).toBeGreaterThan(0);
    }
  });
});
