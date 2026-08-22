import { createDecorator } from '#/_base/di/instantiation';

export interface TowerRateLimitSnapshot {
  /** Effective tower spawn budget: governor capacity clamped to the max. */
  readonly budget: number;
  /** Tower agents currently running (acquired, not yet released). */
  readonly inflight: number;
  /** Epoch ms while which new spawns are refused; null when unblocked. */
  readonly blockedUntil: number | null;
}

export interface ITowerRateLimitService {
  readonly _serviceBrand: undefined;

  reportRateLimited(): void;
  reportSuccess(): void;
  budget(): number;
  acquire(): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  release(): void;
  snapshot(): TowerRateLimitSnapshot;
  reset(): void;
}

export const ITowerRateLimitService =
  createDecorator<ITowerRateLimitService>('towerRateLimitService');
