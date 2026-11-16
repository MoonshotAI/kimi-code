import { isHardLlmFailure, trimLlmErrorMessage } from './classify';

export const ARTEX_DEFAULT_SOFT_TRIP_THRESHOLD = 3;

export const ARTEX_COOLDOWN_LADDER_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
];

export interface ArtexLlmHealthState {
  readonly fails: number;
  readonly trips: number;
  readonly openUntilMs: number;
  readonly lastError: string;
  readonly lastAtMs: number;
}

export interface ArtexLlmHealthPolicy {
  readonly softTripThreshold?: number;
  readonly cooldownMs?: number;
}

export interface ArtexLlmHealthPersistence {
  readonly persist?: (id: string, state: ArtexLlmHealthState) => void;
  readonly forget?: (id: string) => void;
}

export interface ArtexLlmHealthRegistryOptions {
  readonly policy?: ArtexLlmHealthPolicy;
  readonly persistence?: ArtexLlmHealthPersistence;
  readonly now?: () => number;
}

export interface ArtexLlmHealthFailureOptions {
  readonly hard?: boolean;
}

export class ArtexLlmHealthRegistry {
  private readonly states = new Map<string, ArtexLlmHealthState>();
  private readonly persistence: ArtexLlmHealthPersistence | undefined;
  private readonly now: () => number;
  private softTripThreshold: number;
  private cooldownMs: number;

  constructor(options: ArtexLlmHealthRegistryOptions = {}) {
    this.persistence = options.persistence;
    this.now = options.now ?? Date.now;
    this.softTripThreshold = options.policy?.softTripThreshold ?? 0;
    this.cooldownMs = options.policy?.cooldownMs ?? 0;
  }

  setPolicy(policy: ArtexLlmHealthPolicy): void {
    this.softTripThreshold = policy.softTripThreshold ?? 0;
    this.cooldownMs = policy.cooldownMs ?? 0;
  }

  restore(id: string, state: ArtexLlmHealthState): void {
    this.states.set(id, { ...state });
  }

  get(id: string): ArtexLlmHealthState | undefined {
    const state = this.states.get(id);
    return state === undefined ? undefined : { ...state };
  }

  isHealthy(id: string): boolean {
    const state = this.states.get(id);
    if (state === undefined) return true;
    return this.now() >= state.openUntilMs;
  }

  isOpen(id: string): boolean {
    return !this.isHealthy(id);
  }

  recordSuccess(id: string): void {
    const state = this.states.get(id);
    if (
      state === undefined ||
      (state.fails === 0 && state.trips === 0 && state.openUntilMs === 0)
    ) {
      return;
    }
    this.states.delete(id);
    this.persistence?.forget?.(id);
  }

  recordFailure(
    id: string,
    error: unknown,
    options: ArtexLlmHealthFailureOptions = {},
  ): boolean {
    const prev = this.states.get(id) ?? {
      fails: 0,
      trips: 0,
      openUntilMs: 0,
      lastError: '',
      lastAtMs: 0,
    };
    const now = this.now();
    const hard = options.hard ?? isHardLlmFailure(error);
    const softTrip = this.effectiveSoftTripThreshold();
    let fails = prev.fails + 1;
    let trips = prev.trips;
    let openUntilMs = prev.openUntilMs;
    let tripped = false;

    if (hard || (softTrip > 0 && fails >= softTrip)) {
      trips += 1;
      openUntilMs = now + this.cooldownForTrip(trips);
      fails = 0;
      tripped = true;
    }

    const next: ArtexLlmHealthState = {
      fails,
      trips,
      openUntilMs,
      lastError: trimLlmErrorMessage(error),
      lastAtMs: now,
    };
    this.states.set(id, next);
    this.persistence?.persist?.(id, { ...next });
    return tripped;
  }

  reset(id: string): void {
    this.states.delete(id);
    this.persistence?.forget?.(id);
  }

  snapshot(): Record<string, ArtexLlmHealthState> {
    const out: Record<string, ArtexLlmHealthState> = {};
    for (const [id, state] of this.states.entries()) {
      out[id] = { ...state };
    }
    return out;
  }

  private effectiveSoftTripThreshold(): number {
    if (this.softTripThreshold === 0) {
      return ARTEX_DEFAULT_SOFT_TRIP_THRESHOLD;
    }
    return Math.max(this.softTripThreshold, 0);
  }

  private cooldownForTrip(trips: number): number {
    if (this.cooldownMs > 0) {
      return this.cooldownMs;
    }
    const index = Math.min(Math.max(trips - 1, 0), ARTEX_COOLDOWN_LADDER_MS.length - 1);
    return ARTEX_COOLDOWN_LADDER_MS[index]!;
  }
}
