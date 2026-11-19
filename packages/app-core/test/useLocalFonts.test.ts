import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterFontFamilies } from '../src/composables/useLocalFonts';

const ORIGINAL_WINDOW = globalThis.window;

async function freshModule() {
  vi.resetModules();
  return await import('../src/composables/useLocalFonts');
}

afterEach(() => {
  if (ORIGINAL_WINDOW === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = ORIGINAL_WINDOW;
});

describe('useLocalFonts', () => {
  it('reports unavailable when the API is missing', async () => {
    (globalThis as { window?: unknown }).window = {};
    const { useLocalFonts } = await freshModule();
    const { localFontsState, localFontFamilies, ensureLocalFonts } = useLocalFonts();
    ensureLocalFonts();
    await Promise.resolve();
    expect(localFontsState.value).toBe('unavailable');
    expect(localFontFamilies.value).toEqual([]);
  });

  it('dedupes and sorts families from queryLocalFonts', async () => {
    const queryLocalFonts = vi.fn().mockResolvedValue([
      { family: 'Sarasa Mono SC' },
      { family: 'Menlo', style: 'Bold', postscriptName: 'Menlo-Bold' },
      { family: 'Menlo', style: 'Regular', postscriptName: 'Menlo-Regular' },
      { family: 'Sarasa Mono SC', style: 'Bold' },
      { family: '' },
      { style: 'Regular' },
      { family: 'Inter' },
    ]);
    (globalThis as { window?: unknown }).window = { queryLocalFonts };
    const { useLocalFonts, getLocalFontFace } = await freshModule();
    const { localFontsState, localFontFamilies, ensureLocalFonts } = useLocalFonts();
    ensureLocalFonts();
    await vi.waitFor(() => expect(localFontsState.value).toBe('ready'));
    expect(localFontFamilies.value).toEqual(['Inter', 'Menlo', 'Sarasa Mono SC']);
    expect(getLocalFontFace('Menlo')?.postscriptName).toBe('Menlo-Regular');
  });

  it('keeps each family\'s full names for search', async () => {
    const queryLocalFonts = vi.fn().mockResolvedValue([
      { family: 'PingFang SC', style: 'Regular', fullName: '苹方-简 常规体' },
      { family: 'PingFang SC', style: 'Semibold', fullName: '苹方-简 中粗体' },
      { family: 'Menlo', style: 'Regular' },
    ]);
    (globalThis as { window?: unknown }).window = { queryLocalFonts };
    const { useLocalFonts, localFontSearchNames } = await freshModule();
    const { localFontsState, ensureLocalFonts } = useLocalFonts();
    ensureLocalFonts();
    await vi.waitFor(() => expect(localFontsState.value).toBe('ready'));
    expect([...localFontSearchNames('PingFang SC')]).toEqual(['苹方-简 常规体', '苹方-简 中粗体']);
    expect(localFontSearchNames('Menlo').size).toBe(0);
    expect(localFontSearchNames('Unknown').size).toBe(0);
  });

  it('queries at most once and turns unavailable on rejection', async () => {
    const queryLocalFonts = vi.fn().mockRejectedValue(new Error('denied'));
    (globalThis as { window?: unknown }).window = { queryLocalFonts };
    const { useLocalFonts } = await freshModule();
    const { localFontsState, ensureLocalFonts } = useLocalFonts();
    ensureLocalFonts();
    await vi.waitFor(() => expect(localFontsState.value).toBe('unavailable'));
    ensureLocalFonts();
    await Promise.resolve();
    expect(queryLocalFonts).toHaveBeenCalledTimes(1);
  });
});

describe('ensureLocalFontsIfPermitted', () => {
  it('enumerates fonts once when several callers race the permission check', async () => {
    const queryLocalFonts = vi.fn().mockResolvedValue([{ family: 'Inter' }]);
    (globalThis as { window?: unknown }).window = { queryLocalFonts };
    vi.stubGlobal('navigator', { permissions: { query: () => Promise.resolve({ state: 'granted' }) } });
    try {
      const { ensureLocalFontsIfPermitted, useLocalFonts } = await freshModule();
      await Promise.all([ensureLocalFontsIfPermitted(), ensureLocalFontsIfPermitted(), ensureLocalFontsIfPermitted()]);
      await vi.waitFor(() => expect(useLocalFonts().localFontsState.value).toBe('ready'));
      expect(queryLocalFonts).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('filterFontFamilies', () => {
  const families = ['Inter', 'Menlo', 'Sarasa Mono SC', 'SF Mono', 'PingFang SC'];

  it('returns the complete list for an empty query', () => {
    expect(filterFontFamilies(families, '')).toEqual(families);
    expect(filterFontFamilies(families, '  ')).toEqual(families);
  });

  it('matches case-insensitive substrings anywhere in the name', () => {
    expect(filterFontFamilies(families, 'mono')).toEqual(['Sarasa Mono SC', 'SF Mono']);
    expect(filterFontFamilies(families, 'SC')).toEqual(['Sarasa Mono SC', 'PingFang SC']);
    expect(filterFontFamilies(families, 'nope')).toEqual([]);
  });

  it('keeps every match beyond the first menu page', () => {
    const many = Array.from({ length: 350 }, (_, i) => `Font ${i}`);
    expect(filterFontFamilies(many, '')).toEqual(many);
    expect(filterFontFamilies(many, 'font')).toEqual(many);
    expect(filterFontFamilies(many, '349')).toEqual(['Font 349']);
  });
});
