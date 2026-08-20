import { describe, expect, it } from 'vitest';
import { resolveOAuthLoginCards } from '../src/lib/oauthLoginCards';

const REGION_CARDS = [
  { region: 'mainland-cn', titleKey: 'login.regionCnTitle', hintKey: 'login.regionCnHint' },
  { region: 'global', titleKey: 'login.regionOverseasTitle', hintKey: 'login.regionOverseasHint' },
] as const;
const FALLBACK = { titleKey: 'login.oauthTitle', hintKey: 'login.oauthHint' } as const;

describe('resolveOAuthLoginCards', () => {
  it('shows the region cards disabled in their declared order while the probe is pending', () => {
    const cards = resolveOAuthLoginCards('pending', REGION_CARDS, FALLBACK);
    expect(cards.map((card) => card.region)).toEqual(['mainland-cn', 'global']);
    // A pre-region daemon would silently strip the region, so no card may be
    // clickable until the probe lands.
    expect(cards.every((card) => card.disabled)).toBe(true);
  });

  it('shows the region cards enabled in their declared order once supported', () => {
    const cards = resolveOAuthLoginCards('supported', REGION_CARDS, FALLBACK);
    expect(cards.map((card) => card.region)).toEqual(['mainland-cn', 'global']);
    expect(cards.every((card) => !card.disabled)).toBe(true);
  });

  it('degrades to the single neutral card on a pre-region daemon', () => {
    const cards = resolveOAuthLoginCards('unsupported', REGION_CARDS, FALLBACK);
    expect(cards).toHaveLength(1);
    // No region: the click starts the flow without one (the daemon resolves
    // it itself), and the neutral copy is not the region-card copy.
    expect(cards[0]).toEqual({
      titleKey: FALLBACK.titleKey,
      hintKey: FALLBACK.hintKey,
      disabled: false,
    });
    expect(cards[0]?.region).toBeUndefined();
  });
});
