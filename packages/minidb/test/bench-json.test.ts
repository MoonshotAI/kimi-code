// Runs the real bench script in --quick mode and pins the machine-readable
// JSON report's shape: later phases diff before/after numbers, so the field
// names below are a stable contract.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

test('bench --quick emits a JSON report with a stable schema', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-bench-json-'));
  try {
    const reportPath = path.join(dir, 'report.json');
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', path.join(pkgDir, 'bench', 'bench.ts'), '--quick', '--json', reportPath],
      { cwd: pkgDir, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));

    // Top-level envelope.
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.tool, 'minidb/bench');
    assert.equal(typeof report.startedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(report.startedAt)), 'startedAt is an ISO timestamp');
    assert.equal(typeof report.node, 'string');
    assert.equal(typeof report.platform, 'string');
    assert.equal(typeof report.arch, 'string');
    assert.equal(typeof report.seed, 'number');
    assert.ok(Array.isArray(report.scenarios));
    assert.ok(report.scenarios.length >= 10, 'all scenario families ran');

    // Every scenario row carries the shared measurement fields.
    for (const s of report.scenarios) {
      assert.equal(typeof s.name, 'string');
      assert.ok(s.name.length > 0);
      assert.equal(typeof s.durationMs, 'number', `${s.name}.durationMs`);
      assert.ok(s.durationMs >= 0);
      if (s.ops !== undefined) assert.equal(typeof s.ops, 'number', `${s.name}.ops`);
      if (s.opsPerSec !== undefined) assert.equal(typeof s.opsPerSec, 'number', `${s.name}.opsPerSec`);
      for (const k of ['mean', 'p50', 'p95', 'p99', 'max']) {
        assert.equal(typeof s.eventLoopDelayMs[k], 'number', `${s.name}.eventLoopDelayMs.${k}`);
      }
      assert.ok(s.peakRssBytes > 0, `${s.name}.peakRssBytes`);
      assert.ok(s.peakHeapUsedBytes > 0, `${s.name}.peakHeapUsedBytes`);
      if (s.latencyMs !== undefined) {
        for (const k of ['p50', 'p95', 'p99', 'max']) {
          assert.equal(typeof s.latencyMs[k], 'number', `${s.name}.latencyMs.${k}`);
        }
      }
    }

    const byName = (re) => report.scenarios.find((s) => re.test(s.name));

    // Cold open rows expose the recovery/rebuild breakdown.
    const cold = byName(/cold open/);
    assert.ok(cold, 'a cold-open scenario exists');
    for (const k of ['keys', 'recoveryBytes', 'recoveryFrames', 'recoveryDurationMs', 'indexRebuildDurationMs', 'textRebuildDurationMs', 'walFsyncs']) {
      assert.equal(typeof cold.extra[k], 'number', `cold open extra.${k}`);
    }

    // The acceptance scenario: an idle everysec db performs zero fsyncs.
    const idle = byName(/idle everysec/);
    assert.ok(idle, 'the idle everysec scenario exists');
    assert.equal(idle.extra.walFsyncs, 0, 'idle everysec db: zero background fsyncs');
    assert.equal(idle.extra.walFsyncErrors, 0);

    // A write re-arms the background sync.
    const dirty = byName(/write then idle/);
    assert.ok(dirty, 'the dirty-window scenario exists');
    assert.ok(dirty.extra.walFsyncs >= 1, 'a write triggers a background fsync');

    // Search rows report per-query hit counts and medians.
    for (const re of [/search word/, /search ngram/]) {
      const search = byName(re);
      assert.ok(search, `${re} scenario exists`);
      assert.ok(Array.isArray(search.extra.queries));
      for (const q of search.extra.queries) {
        assert.equal(typeof q.q, 'string');
        assert.equal(typeof q.hits, 'number');
        assert.equal(typeof q.medianMs, 'number');
      }
    }

    // The compaction row exposes the phase breakdown.
    const compact = byName(/compact \d/);
    assert.ok(compact, 'a compaction scenario exists');
    for (const k of ['keys', 'compactionDurationMs', 'compactionSnapshotDurationMs', 'compactionRotationDurationMs', 'compactionPostingsDurationMs', 'snapshotBytesWritten']) {
      assert.equal(typeof compact.extra[k], 'number', `compact extra.${k}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 300_000);
