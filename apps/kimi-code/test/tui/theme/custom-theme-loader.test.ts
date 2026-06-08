import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCustomThemesDir,
  listCustomThemes,
  listCustomThemesSync,
  loadCustomTheme,
  loadCustomThemeMerged,
} from '#/tui/theme/custom-theme-loader';
import { darkColors, lightColors } from '#/tui/theme';

let home: string;
const originalHome = process.env['KIMI_CODE_HOME'];

beforeEach(() => {
  home = join(tmpdir(), `kimi-themes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, 'themes'), { recursive: true });
  process.env['KIMI_CODE_HOME'] = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env['KIMI_CODE_HOME'];
  } else {
    process.env['KIMI_CODE_HOME'] = originalHome;
  }
});

function writeTheme(name: string, body: unknown): void {
  writeFileSync(join(getCustomThemesDir(), `${name}.json`), JSON.stringify(body), 'utf-8');
}

describe('custom theme loader', () => {
  it('excludes reserved built-in names from the listing', async () => {
    writeTheme('dark', { name: 'dark', colors: {} });
    writeTheme('light', { name: 'light', colors: {} });
    writeTheme('auto', { name: 'auto', colors: {} });
    writeTheme('solarized', { name: 'solarized', colors: { primary: '#268bd2' } });

    expect(await listCustomThemes()).toEqual(['solarized']);
    expect(listCustomThemesSync()).toEqual(['solarized']);
  });

  it('filters invalid hex values without writing to the terminal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeTheme('mixed', {
        name: 'mixed',
        colors: { primary: '#268bd2', text: 'not-a-hex', accent: '#ff0000' },
      });

      const loaded = await loadCustomTheme('mixed');
      expect(loaded).toEqual({ primary: '#268bd2', accent: '#ff0000' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns null for a missing theme file', async () => {
    expect(await loadCustomTheme('does-not-exist')).toBeNull();
  });

  it('falls back to the dark palette for unspecified tokens by default', async () => {
    writeTheme('solar-dark', { name: 'solar-dark', colors: { primary: '#268bd2' } });
    const merged = await loadCustomThemeMerged('solar-dark');
    expect(merged?.primary).toBe('#268bd2');
    expect(merged?.text).toBe(darkColors.text);
  });

  it('falls back to the light palette when base is "light"', async () => {
    writeTheme('solar-light', {
      name: 'solar-light',
      base: 'light',
      colors: { primary: '#268bd2' },
    });
    const merged = await loadCustomThemeMerged('solar-light');
    expect(merged?.primary).toBe('#268bd2');
    expect(merged?.text).toBe(lightColors.text);
  });
});
