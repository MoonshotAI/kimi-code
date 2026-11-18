import { createHash } from 'node:crypto';

export const MAX_ROLLOUT_DELAY_SECONDS = 86_400;

export interface RolloutBatch {
  readonly percent: number;
  readonly delaySeconds: number;
}

export interface UpdateRolloutInfo {
  readonly version: string;
  readonly publishedAt?: unknown;
  readonly rollout?: unknown;
}

export function rolloutBucket(deviceId: string, version: string): number {
  const digest = createHash('sha256').update(`${deviceId}:${version}`, 'utf8').digest();
  return digest.readUInt32BE(0) % 100;
}

export function rolloutDelayForBucket(rollout: readonly RolloutBatch[], bucket: number): number {
  let cumulative = 0;
  for (const batch of rollout) {
    cumulative += batch.percent;
    if (bucket < cumulative) {
      return Math.min(Math.max(batch.delaySeconds, 0), MAX_ROLLOUT_DELAY_SECONDS);
    }
  }
  return rollout.length === 0 ? 0 : MAX_ROLLOUT_DELAY_SECONDS;
}

function parseRollout(value: unknown): readonly RolloutBatch[] | null {
  if (!Array.isArray(value)) return null;
  const rollout: RolloutBatch[] = [];
  for (const batch of value) {
    if (typeof batch !== 'object' || batch === null) return null;
    const { percent, delaySeconds } = batch as Record<string, unknown>;
    if (
      typeof percent !== 'number' ||
      !Number.isInteger(percent) ||
      percent < 0 ||
      percent > 100 ||
      typeof delaySeconds !== 'number' ||
      !Number.isInteger(delaySeconds) ||
      delaySeconds < 0
    ) {
      return null;
    }
    rollout.push({ percent, delaySeconds });
  }
  return rollout;
}

export function isUpdateRolloutEligible(info: UpdateRolloutInfo, deviceId: string, now: Date): boolean {
  const rollout = parseRollout(info.rollout);
  if (rollout === null || rollout.length === 0 || typeof info.publishedAt !== 'string') return true;
  const publishedAt = Date.parse(info.publishedAt);
  if (!Number.isFinite(publishedAt)) return true;
  const delaySeconds = rolloutDelayForBucket(rollout, rolloutBucket(deviceId, info.version));
  return now.getTime() >= publishedAt + delaySeconds * 1000;
}
