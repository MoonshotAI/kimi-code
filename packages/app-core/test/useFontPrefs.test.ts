import { describe, expect, it } from 'vitest';
import {
  defaultFontPrefs,
  effectiveFontPrefs,
  FONT_FAMILIES_MAX,
  fontCssVars,
  fontModes,
  isGenericFontFamily,
  kimiCodeFontFamilies,
  quoteFontFamily,
  sanitizeFontPrefs,
  systemFontKeyword,
} from '../src/composables/useFontPrefs';

describe('modes', () => {
  it('defaults to kimi for ui and code and to same for transcript and terminal', () => {
    expect(fontModes('ui')).toEqual(['kimi', 'system', 'custom']);
    expect(fontModes('transcript')).toEqual(['same', 'kimi', 'system', 'custom']);
    expect(defaultFontPrefs('ui').mode).toBe('kimi');
    expect(defaultFontPrefs('code').mode).toBe('kimi');
    expect(defaultFontPrefs('transcript').mode).toBe('same');
    expect(defaultFontPrefs('terminal').mode).toBe('same');
    for (const target of ['ui', 'transcript', 'code', 'terminal'] as const) {
      expect(sanitizeFontPrefs(undefined, target)).toEqual(defaultFontPrefs(target));
    }
  });

  it('keeps an explicit mode and never lets ui or code follow', () => {
    expect(sanitizeFontPrefs({ mode: 'kimi', families: ['Inter'] }, 'ui')).toMatchObject({ mode: 'kimi', families: ['Inter'] });
    expect(sanitizeFontPrefs({ mode: 'custom' }, 'transcript').mode).toBe('custom');
    expect(sanitizeFontPrefs({ mode: 'same' }, 'code').mode).toBe('kimi');
    expect(sanitizeFontPrefs({ mode: 'system' }, 'ui').mode).toBe('system');
    expect(sanitizeFontPrefs({ mode: 'bogus', follow: false }, 'terminal').mode).toBe('kimi');
  });

  it('assigns a mode to rows stored before modes existed', () => {
    expect(sanitizeFontPrefs({ families: [] }, 'ui').mode).toBe('kimi');
    expect(sanitizeFontPrefs({ families: ['Inter'], follow: false }, 'ui').mode).toBe('custom');
    expect(sanitizeFontPrefs({ families: [], follow: true }, 'transcript').mode).toBe('same');
    expect(sanitizeFontPrefs({ families: [], follow: false }, 'transcript').mode).toBe('kimi');
    expect(sanitizeFontPrefs({ families: ['Menlo'], follow: false }, 'terminal').mode).toBe('custom');
  });

  it('resolves the effective list from the mode and follows the source row live', () => {
    const map = {
      ui: { ...defaultFontPrefs('ui'), mode: 'custom' as const, families: ['Inter'] },
      transcript: { ...defaultFontPrefs('transcript'), families: ['LXGW WenKai'] },
      code: { ...defaultFontPrefs('code'), mode: 'kimi' as const, families: ['Menlo'] },
      terminal: { ...defaultFontPrefs('terminal'), size: 15 },
    };
    expect(effectiveFontPrefs(map, 'transcript')).toMatchObject({ mode: 'same', families: ['Inter'] });
    expect(effectiveFontPrefs(map, 'terminal')).toMatchObject({ families: ['JetBrains Mono Variable'], size: 15 });
    expect(effectiveFontPrefs(map, 'code').families).toEqual(['JetBrains Mono Variable']);
    expect(effectiveFontPrefs({ ...map, ui: { ...map.ui, mode: 'system' } }, 'ui').families).toEqual([]);
    expect(effectiveFontPrefs({ ...map, ui: { ...map.ui, families: ['Fira Sans'] } }, 'transcript').families).toEqual(['Fira Sans']);
    expect(effectiveFontPrefs({ ...map, transcript: { ...map.transcript, mode: 'custom' } }, 'transcript').families).toEqual([
      'LXGW WenKai',
    ]);
    expect(effectiveFontPrefs({ ...map, ui: { ...map.ui, families: [] } }, 'ui').families).toEqual([]);
  });

  it('pairs each target with its system keyword and Kimi Code fonts', () => {
    expect(systemFontKeyword('ui')).toBe('system-ui');
    expect(systemFontKeyword('terminal')).toBe('ui-monospace');
    expect(kimiCodeFontFamilies('transcript')).toEqual(['Schibsted Grotesk Variable', 'Noto Sans SC Variable']);
    expect(kimiCodeFontFamilies('code')).toEqual(['JetBrains Mono Variable']);
  });
});

describe('sanitizeFontPrefs', () => {
  it('defaults a missing/garbage value', () => {
    expect(sanitizeFontPrefs(null)).toEqual(defaultFontPrefs());
    expect(sanitizeFontPrefs('nope')).toEqual(defaultFontPrefs());
    expect(sanitizeFontPrefs(42)).toEqual(defaultFontPrefs());
  });

  it('drops unknown fields and bad values', () => {
    expect(
      sanitizeFontPrefs({ families: 'nope', size: 'big', regular: null, bold: {}, features: '???', extra: 1 }),
    ).toEqual(defaultFontPrefs());
  });

  it('sanitizes the families list: string-breakout chars, empties, duplicates, cap', () => {
    expect(
      sanitizeFontPrefs({ families: ['"Maple Mono";{}', '', '  ', 'Menlo', 'Menlo', 'Maple Mono;{}'] }).families,
    ).toEqual(['Maple Mono;{}', 'Menlo']);
    expect(sanitizeFontPrefs({ families: [`King's Caslon`, 'A\\B'] }).families).toEqual([`King's Caslon`, 'AB']);
    const many = Array.from({ length: FONT_FAMILIES_MAX + 5 }, (_, i) => `Font ${i}`);
    expect(sanitizeFontPrefs({ families: many }).families).toHaveLength(FONT_FAMILIES_MAX);
    expect(sanitizeFontPrefs({ families: ['A'.repeat(150)] }).families[0]).toHaveLength(100);
  });

  it('normalises the Safari-only system keyword to system-ui', () => {
    expect(
      sanitizeFontPrefs({ mode: 'custom', families: ['-apple-system', 'Noto Sans SC Variable', 'Arial', '-Apple-System'] }, 'transcript'),
    ).toEqual({ mode: 'custom', families: ['system-ui', 'Noto Sans SC Variable', 'Arial'], size: null });
  });

  it('drops generics and everything after the first one', () => {
    expect(sanitizeFontPrefs({ families: ['Inter', 'system-ui', 'sans-serif', 'Noto Sans SC'] }).families).toEqual([
      'Inter',
      'system-ui',
    ]);
    expect(sanitizeFontPrefs({ families: ['ui-monospace', 'Monospace', 'Menlo'] }).families).toEqual(['ui-monospace']);
    expect(sanitizeFontPrefs({ families: ['serif'] }, 'ui')).toMatchObject({ mode: 'kimi', families: [] });
    expect(isGenericFontFamily('Fantasy')).toBe(true);
    expect(isGenericFontFamily('system-ui')).toBe(false);
  });

  it('migrates a legacy single family string', () => {
    expect(sanitizeFontPrefs({ family: 'JetBrains Mono' }).families).toEqual(['JetBrains Mono']);
    expect(sanitizeFontPrefs({ family: '' }).families).toEqual([]);
    expect(sanitizeFontPrefs({ families: ['A'], family: 'B' }).families).toEqual(['A']);
  });

  it('clamps size into range', () => {
    expect(sanitizeFontPrefs({ size: 4 }).size).toBe(9);
    expect(sanitizeFontPrefs({ size: 100 }).size).toBe(32);
    expect(sanitizeFontPrefs({ size: Number.NaN }).size).toBeNull();
  });

  it('rounds fractional numbers', () => {
    expect(sanitizeFontPrefs({ size: 13.6 }).size).toBe(14);
  });
});

describe('fontCssVars', () => {
  it('emits removals for an all-default target', () => {
    const pairs = fontCssVars('code', defaultFontPrefs('code'));
    expect(pairs).toEqual([
      ['--user-font-mono', ''],
      ['--user-code-size', ''],
    ]);
  });

  it('joins the fallback list into a quoted comma list', () => {
    expect(
      fontCssVars('transcript', {
        mode: 'custom',
        families: ['LXGW WenKai', 'Inter'],
        size: 16,
      }),
    ).toEqual([
      ['--user-font-transcript', '"LXGW WenKai", "Inter"'],
      ['--user-transcript-size', ''],
    ]);
  });

  it('leads with a bare system-ui keyword for the system entry', () => {
    expect(
      fontCssVars('transcript', { mode: 'custom', families: ['system-ui', 'Noto Sans SC Variable', 'Arial'], size: null })[0],
    ).toEqual(['--user-font-transcript', 'system-ui, "Noto Sans SC Variable", "Arial"']);
  });

  it('expands the system monospace entry into the literal system mono list', () => {
    expect(
      fontCssVars('code', { mode: 'custom', families: ['ui-monospace', 'JetBrains Mono Variable'], size: null })[0],
    ).toEqual([
      '--user-font-mono',
      'ui-monospace, "SF Mono", SFMono-Regular, Menlo, "Cascadia Mono", Consolas, "JetBrains Mono Variable"',
    ]);
  });

  it('keeps system keywords unquoted', () => {
    expect(quoteFontFamily('system-ui')).toBe('system-ui');
    expect(quoteFontFamily('-apple-system')).toBe('-apple-system');
    expect(quoteFontFamily(`King's Caslon`)).toBe(`"King's Caslon"`);
  });

  it('only honors size for the terminal target', () => {
    expect(fontCssVars('ui', { ...defaultFontPrefs('ui'), size: 15 })).toContainEqual(['--base-font', '']);
    expect(fontCssVars('code', { ...defaultFontPrefs('code'), size: 15 })).toContainEqual(['--user-code-size', '']);
    expect(fontCssVars('terminal', { ...defaultFontPrefs('terminal'), size: 15 })).toContainEqual(['--user-terminal-size', '15px']);
  });

  it('drops a stored non-terminal size on sanitize', () => {
    expect(sanitizeFontPrefs({ size: 16 }, 'code').size).toBeNull();
    expect(sanitizeFontPrefs({ size: 16 }, 'terminal').size).toBe(16);
  });

  it('emits the Kimi Code fonts for a kimi row through the effective prefs', () => {
    const map = {
      ui: defaultFontPrefs('ui'),
      transcript: defaultFontPrefs('transcript'),
      code: { ...defaultFontPrefs('code'), mode: 'kimi' as const },
      terminal: { ...defaultFontPrefs('terminal'), size: 14 },
    };
    expect(fontCssVars('terminal', effectiveFontPrefs(map, 'terminal'))).toEqual([
      ['--user-font-terminal', '"JetBrains Mono Variable"'],
      ['--user-terminal-size', '14px'],
    ]);
    expect(fontCssVars('transcript', effectiveFontPrefs(map, 'transcript'))[0]).toEqual([
      '--user-font-transcript',
      '"Schibsted Grotesk Variable", "Noto Sans SC Variable"',
    ]);
  });
});
