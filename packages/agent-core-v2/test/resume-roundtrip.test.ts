/**
 * One-off experiment (not part of the example suite): resume every per-agent
 * `wire.jsonl` copied from the real `~/.kimi-code/sessions` into an isolated
 * home, and verify restore is lossless by a round-trip:
 *
 *   restore(original) -> records1
 *   dump(records1)  -> _redump/.../wire.jsonl  (metadata envelope + records1)
 *   restore(_redump)-> records2
 *   pass iff records1 deep-equals records2
 *
 * `rewriteMigratedRecords: false` keeps the copied originals byte-identical so
 * the experiment is reproducible and never mutates the copied data.
 *
 * Run:
 *   pnpm exec vitest run test/resume-roundtrip.test.ts
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap';
import {
  AgentWireRecordService,
  AGENT_WIRE_PROTOCOL_VERSION,
  IAgentWireRecordService,
  type PersistedWireRecord,
} from '#/agent/wireRecord';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubBootstrap } from './bootstrap/stubs';

const DST = '/Users/moonshot/Projects/kimi-code-mini-bench/.vitest-results/resume-roundtrip-clean';
const SESSIONS = join(DST, 'sessions');
const REDUMP = join(DST, '_redump');
const REPORT = join(DST, 'resume-report.json');
const CONCURRENCY = 1;

interface WireTarget {
  readonly agentHomedir: string;
  readonly relPath: string;
}

interface RestoreError {
  readonly relPath: string;
  readonly error: string;
}

interface Mismatch {
  readonly relPath: string;
  readonly len1: number;
  readonly len2: number;
  readonly firstDiffIndex: number;
  readonly r1Type?: string;
  readonly r2Type?: string;
}

interface Report {
  readonly total: number;
  readonly pass: number;
  readonly restoreErrors: readonly RestoreError[];
  readonly mismatches: readonly Mismatch[];
  readonly durationMs: number;
}

function enumerateWireTargets(): WireTarget[] {
  const targets: WireTarget[] = [];
  for (const ws of readDirs(SESSIONS)) {
    const wsDir = join(SESSIONS, ws);
    for (const sid of readDirs(wsDir)) {
      const agentsDir = join(wsDir, sid, 'agents');
      if (!existsSync(agentsDir)) continue;
      for (const aid of readDirs(agentsDir)) {
        const agentHomedir = join(agentsDir, aid);
        if (existsSync(join(agentHomedir, 'wire.jsonl'))) {
          targets.push({ agentHomedir, relPath: `${ws}/${sid}/agents/${aid}` });
        }
      }
    }
  }
  return targets;
}

function readDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function firstDiffIndex(
  a: readonly PersistedWireRecord[],
  b: readonly PersistedWireRecord[],
): { index: number; r1Type?: string; r2Type?: string } {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      return { index: i, r1Type: a[i]?.type, r2Type: b[i]?.type };
    }
  }
  return { index: n, r1Type: a[n]?.type, r2Type: b[n]?.type };
}

async function roundTrip(
  bootstrap: ReturnType<typeof stubBootstrap>,
  log: InstanceType<typeof AppendLogStore>,
  target: WireTarget,
): Promise<{ ok: true } | { ok: false; stage: 'restore'; error: string } | { ok: false; stage: 'mismatch'; mismatch: Mismatch }> {
  let r1: readonly PersistedWireRecord[];
  try {
    const wire1 = new AgentWireRecordService(
      { homedir: target.agentHomedir },
      bootstrap,
      undefined,
      log,
    );
    await wire1.restore(undefined, { rewriteMigratedRecords: false });
    r1 = wire1.getRecords();
  } catch (error) {
    return { ok: false, stage: 'restore', error: String(error) };
  }

  const redumpHomedir = join(REDUMP, target.relPath);
  const redumpFile = join(redumpHomedir, 'wire.jsonl');
  mkdirSync(dirname(redumpFile), { recursive: true });
  writeFileSync(
    redumpFile,
    [
      JSON.stringify({ type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 }),
      ...r1.map((record) => JSON.stringify(record)),
    ].join('\n') + '\n',
  );

  let r2: readonly PersistedWireRecord[];
  try {
    const wire2 = new AgentWireRecordService(
      { homedir: redumpHomedir },
      bootstrap,
      undefined,
      log,
    );
    await wire2.restore(undefined, { rewriteMigratedRecords: false });
    r2 = wire2.getRecords();
  } catch (error) {
    return { ok: false, stage: 'restore', error: `redump: ${String(error)}` };
  }

  if (JSON.stringify(r1) === JSON.stringify(r2)) {
    return { ok: true };
  }
  const diff = firstDiffIndex(r1, r2);
  return {
    ok: false,
    stage: 'mismatch',
    mismatch: {
      relPath: target.relPath,
      len1: r1.length,
      len2: r2.length,
      firstDiffIndex: diff.index,
      r1Type: diff.r1Type,
      r2Type: diff.r2Type,
    },
  };
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
      done++;
      if (done % 200 === 0) onProgress?.(done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  onProgress?.(done);
  return results;
}

describe('resume round-trip over real ~/.kimi-code wire logs', () => {
  it('restores every per-agent wire.jsonl and verifies lossless round-trip', async () => {
    const targets = enumerateWireTargets();
    const bootstrap = stubBootstrap(DST);
    const storage = new FileStorageService(DST);
    const ix = new TestInstantiationService();
    ix.stub(IFileSystemStorageService, storage);
    ix.stub(IBootstrapService, bootstrap);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = ix.get(IAppendLogStore) as InstanceType<typeof AppendLogStore>;

    const started = Date.now();
    const results = await mapPool(
      targets,
      CONCURRENCY,
      (target) => roundTrip(bootstrap, log, target),
      (done) => console.log(`  ... ${done}/${targets.length}`),
    );

    const restoreErrors: RestoreError[] = [];
    const mismatches: Mismatch[] = [];
    let pass = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.ok) {
        pass++;
      } else if (result.stage === 'restore') {
        restoreErrors.push({ relPath: targets[i]!.relPath, error: result.error });
      } else {
        mismatches.push(result.mismatch);
      }
    }

    const report: Report = {
      total: targets.length,
      pass,
      restoreErrors,
      mismatches,
      durationMs: Date.now() - started,
    };
    writeFileSync(REPORT, JSON.stringify(report, null, 2));

    console.log('\n=== resume round-trip report ===');
    console.log(`total:           ${report.total}`);
    console.log(`pass:            ${report.pass}`);
    console.log(`restore errors:  ${report.restoreErrors.length}`);
    console.log(`mismatches:      ${report.mismatches.length}`);
    console.log(`duration:        ${(report.durationMs / 1000).toFixed(1)}s`);
    console.log(`report:          ${REPORT}`);
    if (restoreErrors.length > 0) {
      console.log('\nfirst restore errors:');
      for (const entry of restoreErrors.slice(0, 5)) {
        console.log(`  ${entry.relPath}: ${entry.error.split('\n')[0]}`);
      }
    }
    if (mismatches.length > 0) {
      console.log('\nfirst mismatches:');
      for (const entry of mismatches.slice(0, 5)) {
        console.log(
          `  ${entry.relPath}: len ${entry.len1}->${entry.len2} firstDiff@${entry.firstDiffIndex} (${entry.r1Type} vs ${entry.r2Type})`,
        );
      }
    }
  }, 60 * 60 * 1000);
});
