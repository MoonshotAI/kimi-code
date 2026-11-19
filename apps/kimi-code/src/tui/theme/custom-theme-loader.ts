import { readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { getDataDir } from '#/utils/paths';
import type { ColorPalette, ResolvedTheme } from './colors';
import { getBuiltInPalette } from './colors';

export const CustomThemeSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  base: z.enum(['dark', 'light']).optional(),
  colors: z.record(z.string(), z.string()).optional(),
});

export type CustomThemeDefinition = z.infer<typeof CustomThemeSchema>;

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

const RESERVED_THEME_NAMES: ReadonlySet<string> = new Set(['dark', 'light', 'auto']);

export function getCustomThemesDir(): string {
  return join(getDataDir(), 'themes');
}

interface ParsedCustomTheme {
  readonly base: ResolvedTheme;
  readonly colors: Partial<ColorPalette>;
}

async function readCustomTheme(name: string): Promise<ParsedCustomTheme | null> {
  try {
    const content = await readFile(join(getCustomThemesDir(), `${name}.json`), 'utf-8');
    const parsed = CustomThemeSchema.parse(JSON.parse(content));

    const colors = Object.fromEntries(
      Object.entries(parsed.colors ?? {}).filter(([, v]) => HEX_COLOR_REGEX.test(v)),
    ) as Partial<ColorPalette>;

    return { base: parsed.base ?? 'dark', colors };
  } catch {
    return null;
  }
}

export async function loadCustomTheme(name: string): Promise<Partial<ColorPalette> | null> {
  return (await readCustomTheme(name))?.colors ?? null;
}

export async function loadCustomThemeMerged(name: string): Promise<ColorPalette | null> {
  const parsed = await readCustomTheme(name);
  if (parsed === null) return null;
  return { ...getBuiltInPalette(parsed.base), ...parsed.colors };
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

export function listCustomThemesSync(): string[] {
  try {
    const entries = readdirSync(getCustomThemesDir(), { withFileTypes: true });
    return toThemeNames(entries.filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    return [];
  }
}
