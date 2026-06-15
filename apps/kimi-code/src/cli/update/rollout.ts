import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { getUpdateRolloutLogFile } from '#/utils/paths';

import { selectUpdateTarget } from './select';
import type { RolloutBatch, UpdateManifest, UpdateTarget } from './types';

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

/** Which case a passive update check hit; written to the rollout log. */
export type PassiveUpdateReason =
  /** Nothing known yet (no cache / CDN never reached). */
  | 'no-latest'
  /** Known version is not an upgrade over the running one. */
  | 'not-newer'
  /** Plain-text fallback or legacy cache: visible immediately, no gating. */
  | 'no-manifest'
  /** Gated: this device's batch delay has not elapsed yet. */
  | 'held'
  /** Gated and the batch delay has elapsed: update is visible. */
  | 'eligible'
  /** KIMI_CODE_EXPERIMENTAL_FLAG is on: rollout skipped, newest always visible. */
  | 'experimental';

export interface PassiveUpdateDecision {
  readonly target: UpdateTarget | null;
  readonly reason: PassiveUpdateReason;
  readonly bucket: number | null;
  readonly delaySeconds: number | null;
  readonly eligibleAt: string | null;
}

/**
 * Update decision for the passive surfaces (background install, startup
 * prompt, manual-command notice). Devices whose batch is not yet eligible see
 * no update at all. A null manifest (plain-text fallback or legacy cache)
 * keeps the pre-rollout behavior: the latest version is visible immediately.
 *
 * `kimi upgrade` must NOT go through this gate — it selects directly from the
 * raw latest version.
 */
export function decidePassiveUpdateTarget(
  currentVersion: string,
  latest: string | null,
  manifest: UpdateManifest | null,
  deviceId: string,
  now: Date,
  bypassRollout = false,
): PassiveUpdateDecision {
  if (bypassRollout) {
    if (latest === null) {
      return { target: null, reason: 'no-latest', bucket: null, delaySeconds: null, eligibleAt: null };
    }
    const target = selectUpdateTarget(currentVersion, latest);
    return {
      target,
      reason: target === null ? 'not-newer' : 'experimental',
      bucket: null,
      delaySeconds: null,
      eligibleAt: null,
    };
  }

  if (manifest === null) {
    if (latest === null) {
      return { target: null, reason: 'no-latest', bucket: null, delaySeconds: null, eligibleAt: null };
    }
    const target = selectUpdateTarget(currentVersion, latest);
    return {
      target,
      reason: target === null ? 'not-newer' : 'no-manifest',
      bucket: null,
      delaySeconds: null,
      eligibleAt: null,
    };
  }

  const target = selectUpdateTarget(currentVersion, manifest.version);
  if (target === null) {
    return { target: null, reason: 'not-newer', bucket: null, delaySeconds: null, eligibleAt: null };
  }

  const bucket = rolloutBucket(deviceId, manifest.version);
  const delaySeconds = rolloutDelayForBucket(manifest.rollout, bucket);
  const publishedAt = Date.parse(manifest.publishedAt);
  const eligibleAt = Number.isFinite(publishedAt)
    ? new Date(publishedAt + delaySeconds * 1000).toISOString()
    : null;
  const eligible = isRolloutEligible(manifest, deviceId, now);
  return {
    target: eligible ? target : null,
    reason: eligible ? 'eligible' : 'held',
    bucket,
    delaySeconds,
    eligibleAt,
  };
}

export function selectPassiveUpdateTarget(
  currentVersion: string,
  latest: string | null,
  manifest: UpdateManifest | null,
  deviceId: string,
  now: Date,
): UpdateTarget | null {
  return decidePassiveUpdateTarget(currentVersion, latest, manifest, deviceId, now).target;
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
