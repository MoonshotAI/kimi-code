/**
 * Custom theme loader — reads JSON files from `~/.kimi-code/themes/`.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { getDataDir } from '#/utils/paths';
import type { ColorPalette } from './colors';
import { darkColors } from './colors';

export const CustomThemeSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  colors: z.record(z.string(), z.string()).optional(),
});

export type CustomThemeDefinition = z.infer<typeof CustomThemeSchema>;

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

export function getCustomThemesDir(): string {
  return join(getDataDir(), 'themes');
}

export async function loadCustomTheme(name: string): Promise<Partial<ColorPalette> | null> {
  try {
    const content = await readFile(join(getCustomThemesDir(), `${name}.json`), 'utf-8');
    const parsed = CustomThemeSchema.parse(JSON.parse(content));

    const errors: string[] = [];
    for (const [key, value] of Object.entries(parsed.colors ?? {})) {
      if (!HEX_COLOR_REGEX.test(value)) {
        errors.push(`colors.${key}: "${value}" is not a valid 6-digit hex color`);
      }
    }
    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`Theme "${name}" has invalid colors:\n${errors.join('\n')}`);
    }

    const validColors = Object.fromEntries(
      Object.entries(parsed.colors ?? {}).filter(([, v]) => HEX_COLOR_REGEX.test(v)),
    );

    return validColors as Partial<ColorPalette>;
  } catch {
    return null;
  }
}

/** Load a custom theme and merge with darkColors fallback. */
export async function loadCustomThemeMerged(name: string): Promise<ColorPalette | null> {
  const custom = await loadCustomTheme(name);
  if (custom === null) return null;
  return { ...darkColors, ...custom };
}

export async function listCustomThemes(): Promise<string[]> {
  try {
    const entries = await readdir(getCustomThemesDir(), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
