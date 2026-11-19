
import type { OAuthRegion } from '../api/types';

export type OAuthRegionSupport = 'pending' | 'supported' | 'unsupported';

export interface OAuthLoginCard {
  region?: OAuthRegion;
  titleKey: string;
  hintKey?: string;
  domain?: string;
  disabled: boolean;
}

export interface OAuthLoginCardSpec {
  region: OAuthRegion;
  titleKey: string;
  hintKey?: string;
  domain?: string;
}

export function resolveOAuthLoginCards(
  support: OAuthRegionSupport,
  regionCards: ReadonlyArray<OAuthLoginCardSpec>,
  fallbackCard: { titleKey: string; hintKey: string },
): OAuthLoginCard[] {
  if (support === 'unsupported') {
    return [{ titleKey: fallbackCard.titleKey, hintKey: fallbackCard.hintKey, disabled: false }];
  }
  return regionCards.map((card) => ({ ...card, disabled: support === 'pending' }));
}
