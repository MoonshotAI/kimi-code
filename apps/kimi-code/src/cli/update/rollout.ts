import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { getUpdateRolloutLogFile } from '#/utils/paths';

import { decideUpdate } from './select';
import type { RolloutBatch, UpdateFeed, UpdateManifest, UpdatePlan } from './types';

/**
 * Hard ceiling for any rollout delay. Combined with the uncovered-bucket
 * fallback below, it guarantees every device sees a release no later than
 * `publishedAt + 24h`, no matter what the published plan says.
 */
export const MAX_ROLLOUT_DELAY_SECONDS = 86_400;

/**
 * Deterministic 0-99 bucket for a device. The version is mixed into the hash
 * so each release reshuffles which devices land in the early batches.
 */
export function rolloutBucket(deviceId: string, version: string): number {
  const digest = createHash('sha256').update(`${deviceId}:${version}`, 'utf-8').digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Delay assigned to a bucket by the published plan. Batches claim bucket
 * ranges in array order; buckets left uncovered (percents summing under 100)
 * fall into the slowest cohort, and oversized delays are clamped to 24h.
 */
export function rolloutDelayForBucket(rollout: readonly RolloutBatch[], bucket: number): number {
  let cumulative = 0;
  for (const batch of rollout) {
    cumulative += batch.percent;
    if (bucket < cumulative) {
      return Math.min(Math.max(batch.delaySeconds, 0), MAX_ROLLOUT_DELAY_SECONDS);
    }
  }
  if (rollout.length === 0) return 0;
  return MAX_ROLLOUT_DELAY_SECONDS;
}

export function rolloutDelaySeconds(manifest: UpdateManifest, deviceId: string): number {
  return rolloutDelayForBucket(manifest.rollout, rolloutBucket(deviceId, manifest.version));
}

export function isRolloutEligible(
  manifest: UpdateManifest,
  deviceId: string,
  now: Date,
): boolean {
  const publishedAt = Date.parse(manifest.publishedAt);
  // Schema validation rejects unparseable timestamps before they get here;
  // fail open defensively so a defect can never block updates indefinitely.
  if (!Number.isFinite(publishedAt)) return true;
  const delayMs = rolloutDelaySeconds(manifest, deviceId) * 1000;
  return now.getTime() >= publishedAt + delayMs;
}

export type PassiveUpdateReason =
  | 'no-latest'
  | 'not-newer'
  | 'no-manifest'
  | 'held'
  | 'eligible'
  | 'experimental'
  | 'switch-channel';

export interface PassiveUpdateDecision {
  readonly plan: UpdatePlan;
  readonly reason: PassiveUpdateReason;
  readonly bucket: number | null;
  readonly delaySeconds: number | null;
  readonly eligibleAt: string | null;
}

function passiveResult(
  plan: UpdatePlan,
  reason: PassiveUpdateReason,
  bucket: number | null = null,
  delaySeconds: number | null = null,
  eligibleAt: string | null = null,
): PassiveUpdateDecision {
  return { plan, reason, bucket, delaySeconds, eligibleAt };
}

export function decidePassiveUpdate(
  currentVersion: string,
  feed: UpdateFeed,
  deviceId: string,
  now: Date,
  experimentalBypass: boolean = false,
): PassiveUpdateDecision {
  const plan = decideUpdate(currentVersion, feed);
  if (plan.kind === 'none') {
    return passiveResult(plan, feed.latest === null ? 'no-latest' : 'not-newer');
  }
  if (plan.kind === 'switch-channel') return passiveResult(plan, 'switch-channel');
  if (experimentalBypass) return passiveResult(plan, 'experimental');
  if (feed.manifest === null) return passiveResult(plan, 'no-manifest');

  const manifest = feed.manifest;
  const bucket = rolloutBucket(deviceId, manifest.version);
  const delaySeconds = rolloutDelayForBucket(manifest.rollout, bucket);
  const publishedAt = Date.parse(manifest.publishedAt);
  const eligibleAt = Number.isFinite(publishedAt)
    ? new Date(publishedAt + delaySeconds * 1000).toISOString()
    : null;
  const eligible = isRolloutEligible(manifest, deviceId, now);
  return passiveResult(
    eligible ? plan : { kind: 'none' },
    eligible ? 'eligible' : 'held',
    bucket,
    delaySeconds,
    eligibleAt,
  );
}

const ROLLOUT_LOG_MAX_BYTES = 256 * 1024;

/**
 * Append one JSON line describing a passive update decision to
 * `<dataDir>/updates/rollout.log`. Best-effort diagnostics: any I/O failure
 * is swallowed — logging must never affect update prompting. The file is
 * reset once it grows past a small cap so it cannot grow unbounded.
 */
export async function appendRolloutDecisionLog(
  entry: Record<string, unknown>,
  filePath: string = getUpdateRolloutLogFile(),
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    const size = await stat(filePath).then((s) => s.size, () => 0);
    if (size > ROLLOUT_LOG_MAX_BYTES) {
      await writeFile(filePath, line, 'utf-8');
      return;
    }
    await appendFile(filePath, line, 'utf-8');
  } catch {
    // Diagnostic logging must never affect the update flow.
  }
}

/**
 * Stable per-installation id used for bucketing when telemetry has already
 * minted one. Missing ids stay ephemeral here so update preflight never
 * creates the telemetry device_id before telemetry can emit first_launch.
 */
export function resolveUpdateDeviceId(): string {
  return readKimiDeviceId(resolveKimiHome()) ?? randomUUID();
}

/**
 * The experimental master switch opts a device out of staged rollouts: the
 * newest version is always visible to the passive update surfaces, exactly as
 * if every release were fully rolled out. Read directly from the env (same
 * truthy values as `KIMI_CODE_NO_AUTO_UPDATE`) — the update preflight runs
 * before the harness exists, so the core flag registry is not consulted.
 * `KIMI_CODE_NO_AUTO_UPDATE` still wins: disabling updates beats opting in.
 */
export function isRolloutBypassedByExperimentalEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = (env['KIMI_CODE_EXPERIMENTAL_FLAG'] ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}
