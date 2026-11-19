import { Type, type Static } from 'typebox';
import { defineBrowserValidator } from './browser-validator';

export const BrowserAutoplaySchema = Type.Enum(['block', 'allow']);
export const BrowserSiteAutoplaySchema = Type.Enum(['default', 'allow', 'block']);
export type BrowserAutoplay = Static<typeof BrowserAutoplaySchema>;
export type BrowserSiteAutoplay = Static<typeof BrowserSiteAutoplaySchema>;
export type BrowserAutoplayPolicy = 'document-user-activation-required' | 'user-gesture-required' | 'no-user-gesture-required';

export const browserValidators = {
  BrowserAutoplaySchema: defineBrowserValidator(BrowserAutoplaySchema),
  BrowserSiteAutoplaySchema: defineBrowserValidator(BrowserSiteAutoplaySchema),
};

export function isBrowserAutoplay(value: unknown): value is BrowserAutoplay {
  return value === 'block' || value === 'allow';
}

export function isBrowserSiteAutoplay(value: unknown): value is BrowserSiteAutoplay {
  return value === 'default' || value === 'allow' || value === 'block';
}

export function resolveBrowserAutoplayPolicy(global: BrowserAutoplay, site: BrowserSiteAutoplay = 'default'): BrowserAutoplayPolicy {
  if (site === 'block') return 'user-gesture-required';
  return site === 'allow' || global === 'allow' ? 'no-user-gesture-required' : 'document-user-activation-required';
}
