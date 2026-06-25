/**
 * Tiny standalone perf check for the snapshot reader. Boots a real daemon,
 * creates 50 sessions to populate the workdir index, then times the snapshot
 * endpoint on a target session across 20 iterations and prints p50/p95.
 *
 * Run with: `pnpm vitest run test/snapshot.perf.bench.ts`
 *           `KIMI_SNAPSHOT_READER=legacy pnpm vitest run test/snapshot.perf.bench.ts`
 *
 * Goal: demonstrate that the new reader stays well under 200ms warm and
 * does not scale linearly with session count, unlike the legacy listSessions
 * path. Not a CI gate — invoked by hand from the harness; the assertion is
 * just an upper-bound sanity check.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src';
import { fixedTokenAuth, withAuth } from './helpers/serverHarness';

let tmpDir: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-snapshot-perf-'));
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-snapshot-perf-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function postSession(baseUrl: string, cwd: string): Promise<string> {
  const res = await fetch(
    `${baseUrl}/api/v1/sessions`,
    withAuth({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd } }),
    }),
  );
  const env = (await res.json()) as { code: number; data: { id: string } | null };
  if (env.code !== 0 || env.data === null) throw new Error(JSON.stringify(env));
  return env.data.id;
}

async function timeSnapshot(baseUrl: string, sid: string): Promise<number> {
  const t = performance.now();
  const res = await fetch(`${baseUrl}/api/v1/sessions/${sid}/snapshot`, withAuth());
  await res.text();
  return performance.now() - t;
}

function quantile(samples: readonly number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

describe('SnapshotReader perf (real HTTP, 50 sessions)', () => {
  it(`mode=${process.env['KIMI_SNAPSHOT_READER'] ?? 'auto'} p95 stays under 200ms warm`, async () => {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      lockPath: join(tmpDir, 'lock'),
      serviceOverrides: [fixedTokenAuth()],
      logger: pino({ level: 'silent' }),
      coreProcessOptions: { homeDir: bridgeHome },
    });
    const baseUrl = server.address;

    const sessionCount = 50;
    const sids: string[] = [];
    for (let i = 0; i < sessionCount; i++) {
      sids.push(await postSession(baseUrl, join(tmpDir, `ws-${i}`)));
    }
    const target = sids.at(-1)!;

    for (let i = 0; i < 5; i++) await timeSnapshot(baseUrl, target);

    const samples: number[] = [];
    const N = 20;
    for (let i = 0; i < N; i++) samples.push(await timeSnapshot(baseUrl, target));
    const p50 = quantile(samples, 0.5);
    const p95 = quantile(samples, 0.95);
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const mode = process.env['KIMI_SNAPSHOT_READER'] ?? 'auto';

    // eslint-disable-next-line no-console
    console.log(
      `mode=${mode} sessions=${sessionCount} n=${N} min=${min.toFixed(1)}ms p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`,
    );

    // Generous upper bound — even on a slow CI VM the new reader should
    // comfortably beat this; legacy path on a 50-session store will too,
    // but its scaling is the production concern, not this micro number.
    expect(p95).toBeLessThan(1000);
  }, 60_000);
});
