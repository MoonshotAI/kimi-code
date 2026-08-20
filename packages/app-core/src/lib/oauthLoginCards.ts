// packages/app-core/src/lib/oauthLoginCards.ts
// Card model for the OAuth login choice step (the standalone LoginDialog and
// the onboarding wizard's login step, both ends). The daemon gained host-
// region support together with the dual-entry login UI; an older daemon
// silently strips the unknown `region` field, so offering the two endpoint
// cards there would promise a choice the daemon ignores. The mount-time probe
// (getOAuthRegion — null on an older daemon or any failure) gates the cards:
// supported → one card per endpoint in the declared order; unsupported → a
// single neutral card that starts the flow without a region (the pre-region
// behavior: the daemon resolves the region itself).

import type { OAuthRegion } from '../api/types';

/** Whether the connected daemon understands the `region` field. 'pending' =
    the probe hasn't answered yet. */
export type OAuthRegionSupport = 'pending' | 'supported' | 'unsupported';

/** One card on the login choice step. `region` is undefined on the neutral
    fallback card — clicking it starts the flow with no region. */
export interface OAuthLoginCard {
  region?: OAuthRegion;
  titleKey: string;
  hintKey: string;
  /** True while the daemon-support probe is still in flight — the cards stay
      visible (nothing visibly swaps on the common region-aware path) but must
      not be clickable: on a pre-region daemon a click would send a region the
      daemon silently strips, promising a choice it ignores. */
  disabled: boolean;
}

/** A region-card declaration: the region plus its i18n copy keys. */
export interface OAuthLoginCardSpec {
  region: OAuthRegion;
  titleKey: string;
  hintKey: string;
}

/** The cards to show on the choice step.
    - 'pending' (probe still in flight — a loopback round-trip): the region
      cards in their declared order, marked `disabled` so nothing visibly
      swaps when a region-aware daemon (the common case) answers, while a
      click that a pre-region daemon would mis-handle stays impossible until
      the probe lands.
    - 'supported': the region cards in their declared order.
    - 'unsupported' (pre-region daemon): just the neutral fallback card. */
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
