import type { PlanUsageMetric, PlanUsageResult } from "../../shared/types";

export interface PlanUsageSnapshot {
  kind: "ok";
  overall?: PlanUsageMetric;
  fiveHour?: PlanUsageMetric;
  fetchedAt: string;
  stale?: boolean;
  warning?: string;
}

interface UsageEntry {
  usedRatio: number;
  resetAt?: string;
}

interface UsageQuota {
  usages: {
    limit5h?: UsageEntry;
    limit7d?: UsageEntry;
    monthTotal?: UsageEntry;
  };
}

const CACHE_TTL_MS = 60_000;

export function percentLeft(usedRatio: number): number {
  const finiteRatio = Number.isFinite(usedRatio) ? usedRatio : 1;
  const clamped = Math.max(0, Math.min(finiteRatio, 1));
  return Math.round((1 - clamped) * 100);
}

export function toPlanUsageSnapshot(quota: UsageQuota, now = new Date()): PlanUsageSnapshot | null {
  const monthly = quota.usages.monthTotal;
  const weekly = quota.usages.limit7d;
  const fiveHour = quota.usages.limit5h;
  const overallEntry = monthly ?? weekly;

  if (overallEntry === undefined && fiveHour === undefined) return null;

  return {
    kind: "ok",
    ...(overallEntry === undefined
      ? {}
      : {
          overall: {
            label: monthly === undefined ? "Weekly" : "Overall",
            percentLeft: percentLeft(overallEntry.usedRatio),
            ...(overallEntry.resetAt === undefined ? {} : { resetAt: overallEntry.resetAt }),
          },
        }),
    ...(fiveHour === undefined
      ? {}
      : {
          fiveHour: {
            label: "5h",
            percentLeft: percentLeft(fiveHour.usedRatio),
            ...(fiveHour.resetAt === undefined ? {} : { resetAt: fiveHour.resetAt }),
          },
        }),
    fetchedAt: now.toISOString(),
  };
}

export class ManagedUsageCache {
  private cached: PlanUsageSnapshot | undefined;
  private fetchedAtMs = 0;
  private inFlight: Promise<PlanUsageResult> | undefined;

  async get(
    fetchUsage: () => Promise<
      | { kind: "ok"; quota: UsageQuota }
      | { kind: "error"; message: string }
    >,
    options: { force?: boolean; now?: () => Date } = {},
  ): Promise<PlanUsageResult> {
    const now = options.now ?? (() => new Date());
    const currentMs = now().getTime();
    if (!options.force && this.cached !== undefined && currentMs - this.fetchedAtMs < CACHE_TTL_MS) {
      return this.cached;
    }
    if (this.inFlight !== undefined) return this.inFlight;

    const request = this.refresh(fetchUsage, now);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  clear(): void {
    this.cached = undefined;
    this.fetchedAtMs = 0;
  }

  private async refresh(
    fetchUsage: () => Promise<
      | { kind: "ok"; quota: UsageQuota }
      | { kind: "error"; message: string }
    >,
    now: () => Date,
  ): Promise<PlanUsageResult> {
    const result = await fetchUsage();
    if (result.kind === "error") {
      return this.cached === undefined
        ? result
        : { ...this.cached, stale: true, warning: result.message };
    }

    const fetchedAt = now();
    const snapshot = toPlanUsageSnapshot(result.quota, fetchedAt);
    if (snapshot === null) {
      return {
        kind: "unavailable",
        message: "Kimi did not return plan usage limits for this account.",
      };
    }
    this.cached = snapshot;
    this.fetchedAtMs = fetchedAt.getTime();
    return snapshot;
  }
}
