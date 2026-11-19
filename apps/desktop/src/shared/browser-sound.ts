import { Type, type Static } from 'typebox';
import { defineBrowserValidator } from './browser-validator';

export const BrowserSoundSchema = Type.Enum(['muted', 'on']);
export const BrowserSiteSoundSchema = Type.Enum(['default', 'on', 'muted']);
export type BrowserSound = Static<typeof BrowserSoundSchema>;
export type BrowserSiteSound = Static<typeof BrowserSiteSoundSchema>;

export const browserValidators = {
  BrowserSoundSchema: defineBrowserValidator(BrowserSoundSchema),
  BrowserSiteSoundSchema: defineBrowserValidator(BrowserSiteSoundSchema),
};

export function isBrowserSound(value: unknown): value is BrowserSound {
  return value === 'muted' || value === 'on';
}

export function isBrowserSiteSound(value: unknown): value is BrowserSiteSound {
  return value === 'default' || value === 'on' || value === 'muted';
}

export function resolveBrowserSoundMuted(global: BrowserSound, site: BrowserSiteSound = 'default'): boolean {
  return (site === 'default' ? global : site) === 'muted';
}
