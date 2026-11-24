export type BundledFontKind = 'sans' | 'mono';

export const BUNDLED_FONTS = [
  {
    family: 'Schibsted Grotesk Variable',
    label: 'Schibsted Grotesk',
    aliases: ['Schibsted Grotesk Variable', 'Schibsted Grotesk'],
    kind: 'sans',
    weight: [400, 900],
  },
  {
    family: 'Noto Sans SC Variable',
    label: 'Noto Sans SC',
    aliases: ['Noto Sans SC Variable', 'Noto Sans SC'],
    kind: 'sans',
    weight: [100, 900],
  },
  {
    family: 'JetBrains Mono Variable',
    label: 'JetBrains Mono',
    aliases: ['JetBrains Mono Variable', 'JetBrains Mono'],
    kind: 'mono',
    weight: [100, 800],
  },
] as const satisfies readonly {
  family: string;
  label: string;
  aliases: readonly string[];
  kind: BundledFontKind;
  weight: readonly [number, number];
}[];

export function getBundledFont(family: string) {
  const name = family.trim().toLowerCase();
  return BUNDLED_FONTS.find((font) => font.aliases.some((alias) => alias.toLowerCase() === name));
}

export function bundledFontsOfKind(kind: BundledFontKind): string[] {
  return BUNDLED_FONTS.filter((font) => font.kind === kind).map((font) => font.family);
}
