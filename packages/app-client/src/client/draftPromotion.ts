
export interface DraftPromotion {
  workspaceId: string;
  sessionId: string;
}

let current: DraftPromotion | null = null;

export function markDraftPromotion(promotion: DraftPromotion): void {
  current = promotion;
}

export function consumeDraftPromotionOnSessionChange(id: string | undefined): void {
  if (current !== null && id !== current.sessionId) {
    current = null;
  }
}

export function getDraftPromotion(): DraftPromotion | null {
  return current;
}

export function resetDraftPromotion(): void {
  current = null;
}
