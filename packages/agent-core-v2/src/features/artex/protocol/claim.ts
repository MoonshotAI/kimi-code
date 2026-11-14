import { randomBytes } from 'node:crypto';

export const ARTEX_INTENT_CLAIM_TTL_MS = 90_000;

export const ARTEX_INTENT_CLAIM_HEARTBEAT_INTERVAL_MS = 15_000;

export type ArtexIntentSettleState = 'done' | 'exhausted' | 'blocked' | 'stopped' | 'paused';

export const ARTEX_INTENT_SETTLE_STATES: readonly ArtexIntentSettleState[] = [
  'done',
  'exhausted',
  'blocked',
  'stopped',
  'paused',
];

export class ArtexIntentClaimLostError extends Error {
  constructor(intentId: number, action: string) {
    super(
      `intent claim lost: ${action} for intent ${String(intentId)} was rejected by the claim fence — its claim expired and another worker took it over, or it was already settled; nothing was written`,
    );
    this.name = 'ArtexIntentClaimLostError';
  }
}

export class ArtexIntentStateConflictError extends Error {
  constructor(intentId: number) {
    super(
      `intent state changed concurrently: intent ${String(intentId)} is no longer in the running state`,
    );
    this.name = 'ArtexIntentStateConflictError';
  }
}

export function newArtexUnclaimToken(): string {
  return randomBytes(16).toString('hex');
}

export interface ArtexClaimResult {
  readonly claimed: boolean;
  readonly token?: string;
}

export interface ArtexTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ArtexTokenUsageEntry extends ArtexTokenUsage {
  readonly worker?: string;
  readonly nodeId?: number;
  readonly at: string;
}

export interface ArtexTokenRollup extends ArtexTokenUsage {
  readonly totalTokens: number;
  readonly byWorker: Readonly<Record<string, ArtexTokenUsage>>;
}
