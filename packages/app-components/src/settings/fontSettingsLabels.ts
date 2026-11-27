import { useI18n } from 'vue-i18n';
import { fontFamilyKind, type FontTarget, type LocalFontsState } from '@moonshot-ai/app-core/composables';
import { fontMetadataText, getBundledFont } from '@moonshot-ai/app-core/lib';
import { useFontMetadata } from '@moonshot-ai/app-client/composables';

export const FONT_TITLE_KEYS: Record<FontTarget, string> = {
  ui: 'settings.uiFont',
  transcript: 'settings.transcriptFont',
  code: 'settings.codeFont',
  terminal: 'settings.terminalFont',
};

export const FONT_HINT_KEYS: Record<FontTarget, string> = {
  ui: 'settings.uiFontHint',
  transcript: 'settings.transcriptFontHint',
  code: 'settings.codeFontHint',
  terminal: 'settings.terminalFontHint',
};

export function useFontFamilyLabel(): (family: string) => string {
  const { t, locale } = useI18n();
  const { fontMetadata } = useFontMetadata();
  return (family) => {
    const kind = fontFamilyKind(family);
    if (kind === 'system-ui') return t('settings.fontSystemUi');
    if (kind === 'system-mono') return t('settings.fontSystemMono');
    const bundled = getBundledFont(family);
    if (bundled?.family === 'Noto Sans SC Variable') return t('settings.fontNotoSansSc');
    return bundled?.label || fontMetadataText(fontMetadata.value[family]?.metadata, locale.value, 'name') || family;
  };
}

export type FontChipOrigin = 'system' | 'bundled' | 'installed' | 'manual';

export const FONT_CHIP_ORIGINS: Record<
  FontChipOrigin,
  { key: string; variant: 'neutral' | 'info' | 'success' | 'warning' }
> = {
  system: { key: 'settings.fontOriginSystemDefault', variant: 'neutral' },
  bundled: { key: 'settings.fontOriginBuiltIn', variant: 'info' },
  installed: { key: 'settings.fontOriginInstalled', variant: 'success' },
  manual: { key: 'settings.fontOriginManual', variant: 'warning' },
};

export function fontChipOrigin(
  family: string,
  localFamilies: readonly string[],
  localState: LocalFontsState,
): FontChipOrigin | null {
  if (fontFamilyKind(family) !== 'font') return 'system';
  if (getBundledFont(family)) return 'bundled';
  const name = family.toLowerCase();
  if (localFamilies.some((candidate) => candidate.toLowerCase() === name)) return 'installed';
  if (localState === 'idle' || localState === 'querying') return null;
  return 'manual';
}
