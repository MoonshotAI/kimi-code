import { describe, expect, it, vi } from "vitest";

import {
  ManagedUsageCache,
  percentLeft,
  toPlanUsageSnapshot,
} from "../src/handlers/managed-usage";

describe("managed plan usage", () => {
  it("converts used ratios to clamped whole remaining percentages", () => {
    expect(percentLeft(0)).toBe(100);
    expect(percentLeft(0.284)).toBe(72);
    expect(percentLeft(1)).toBe(0);
    expect(percentLeft(-3)).toBe(100);
    expect(percentLeft(9)).toBe(0);
    expect(percentLeft(Number.NaN)).toBe(0);
  });

  it("uses monthly total for Overall and includes the rolling 5h window", () => {
    expect(toPlanUsageSnapshot({
      usages: {
        limit5h: { usedRatio: 0.61, resetAt: "2030-01-01T05:00:00Z" },
        limit7d: { usedRatio: 0.2 },
        monthTotal: { usedRatio: 0.28, resetAt: "2030-02-01T00:00:00Z" },
      },
    }, new Date("2030-01-01T00:00:00Z"))).toEqual({
      kind: "ok",
      overall: {
        label: "Overall",
        percentLeft: 72,
        resetAt: "2030-02-01T00:00:00Z",
      },
      fiveHour: {
        label: "5h",
        percentLeft: 39,
        resetAt: "2030-01-01T05:00:00Z",
      },
      fetchedAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("labels weekly fallback truthfully when monthly total is absent", () => {
    expect(toPlanUsageSnapshot({ usages: { limit7d: { usedRatio: 0.1 } } }))
      .toMatchObject({ overall: { label: "Weekly", percentLeft: 90 } });
  });

  it("deduplicates refreshes and preserves the last successful snapshot as stale", async () => {
    const cache = new ManagedUsageCache();
    let resolveFetch!: (value: { kind: "ok"; quota: { usages: { monthTotal: { usedRatio: number } } } }) => void;
    const fetchUsage = vi.fn(() => new Promise<{ kind: "ok"; quota: { usages: { monthTotal: { usedRatio: number } } } }>((resolve) => {
      resolveFetch = resolve;
    }));

    const first = cache.get(fetchUsage, { now: () => new Date("2030-01-01T00:00:00Z") });
    const duplicate = cache.get(fetchUsage, { now: () => new Date("2030-01-01T00:00:00Z") });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    resolveFetch({ kind: "ok", quota: { usages: { monthTotal: { usedRatio: 0.25 } } } });
    await expect(first).resolves.toMatchObject({ overall: { percentLeft: 75 } });
    await expect(duplicate).resolves.toMatchObject({ overall: { percentLeft: 75 } });

    const failed = await cache.get(
      async () => ({ kind: "error" as const, message: "temporary failure" }),
      { force: true, now: () => new Date("2030-01-01T00:02:00Z") },
    );
    expect(failed).toMatchObject({
      kind: "ok",
      stale: true,
      warning: "temporary failure",
      overall: { percentLeft: 75 },
    });
  });
});
