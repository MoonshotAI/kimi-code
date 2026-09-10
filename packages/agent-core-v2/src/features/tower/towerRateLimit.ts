import { createDecorator } from '#/_base/di/instantiation';

export interface TowerRateLimitSnapshot {
  readonly budget: number;
  readonly inflight: number;
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
