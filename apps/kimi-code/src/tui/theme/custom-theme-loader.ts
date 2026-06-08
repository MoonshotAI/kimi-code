/**
 * Custom theme loader — reads JSON files from `~/.kimi-code/themes/`.
 */

import { readdirSync } from 'node:fs';
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

/**
 * Names reserved for built-in themes. A `dark.json` / `light.json` /
 * `auto.json` file would collide with the built-in value, so it can never be
 * selected as a custom theme — hide it from listings.
 */
const RESERVED_THEME_NAMES: ReadonlySet<string> = new Set(['dark', 'light', 'auto']);

export function getCustomThemesDir(): string {
  return join(getDataDir(), 'themes');
}

export async function loadCustomTheme(name: string): Promise<Partial<ColorPalette> | null> {
  try {
    const content = await readFile(join(getCustomThemesDir(), `${name}.json`), 'utf-8');
    const parsed = CustomThemeSchema.parse(JSON.parse(content));

    // Invalid hex values are dropped (the token falls back to the dark
    // palette). We intentionally do not print here: this loader can run while
    // pi-tui owns the terminal, where raw stdout/stderr writes corrupt the
    // rendered screen. Authoring-time validation lives in the JSON schema.
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

function toThemeNames(files: readonly string[]): string[] {
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((name) => !RESERVED_THEME_NAMES.has(name));
}

export async function listCustomThemes(): Promise<string[]> {
  try {
    const entries = await readdir(getCustomThemesDir(), { withFileTypes: true });
    return toThemeNames(entries.filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    return [];
  }
}

/** Synchronous variant for UI paths (e.g. the `/theme` picker) that cannot await. */
export function listCustomThemesSync(): string[] {
  try {
    const entries = readdirSync(getCustomThemesDir(), { withFileTypes: true });
    return toThemeNames(entries.filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    return [];
  }
}
