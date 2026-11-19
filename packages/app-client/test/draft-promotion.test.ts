import { beforeEach, describe, expect, it } from 'vitest';

import {
  consumeDraftPromotionOnSessionChange,
  getDraftPromotion,
  markDraftPromotion,
  resetDraftPromotion,
} from '../src/client/draftPromotion';

describe('draftPromotion record', () => {
  beforeEach(() => {
    resetDraftPromotion();
  });

  it('is null until a promotion is marked', () => {
    expect(getDraftPromotion()).toBeNull();
    markDraftPromotion({ workspaceId: 'ws-1', sessionId: 'created-1' });
    expect(getDraftPromotion()).toEqual({ workspaceId: 'ws-1', sessionId: 'created-1' });
  });

  it('survives its own promotion flip', () => {
    markDraftPromotion({ workspaceId: 'ws-1', sessionId: 'created-1' });
    consumeDraftPromotionOnSessionChange('created-1');
    expect(getDraftPromotion()?.sessionId).toBe('created-1');
  });

  it('clears on any later navigation (another session, or back to the draft)', () => {
    markDraftPromotion({ workspaceId: 'ws-1', sessionId: 'created-1' });
    consumeDraftPromotionOnSessionChange('created-1');
    consumeDraftPromotionOnSessionChange(undefined);
    expect(getDraftPromotion()).toBeNull();
    consumeDraftPromotionOnSessionChange('created-1');
    expect(getDraftPromotion()).toBeNull();
  });

  it('clears immediately when the flip is to a different session', () => {
    markDraftPromotion({ workspaceId: 'ws-1', sessionId: 'created-1' });
    consumeDraftPromotionOnSessionChange('other-session');
    expect(getDraftPromotion()).toBeNull();
  });

  it('a newer promotion overwrites the older one', () => {
    markDraftPromotion({ workspaceId: 'ws-1', sessionId: 'created-1' });
    markDraftPromotion({ workspaceId: 'ws-2', sessionId: 'created-2' });
    expect(getDraftPromotion()).toEqual({ workspaceId: 'ws-2', sessionId: 'created-2' });
  });
});
