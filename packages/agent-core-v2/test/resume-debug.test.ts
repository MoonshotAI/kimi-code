/**
 * One-off diagnosis: for a handful of mismatching wire logs, print the field-
 * level diff between restore(original) and restore(redump) at the first
 * diverging record, so we can pin the non-idempotent transform in the source.
 *
 * Run:
 *   pnpm exec vitest run test/resume-debug.test.ts
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  type PersistedWireRecord,
} from '#/agent/wireRecord/wireRecord';
import { AgentWireRecordService } from '#/agent/wireRecord/wireRecordService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubBootstrap } from './bootstrap/stubs';

const DST = '/Users/moonshot/Projects/kimi-code-mini-bench/.vitest-results/resume-roundtrip-clean';
const SESSIONS = join(DST, 'sessions');
const REDUMP = join(DST, '_redump-debug');

const TARGETS: readonly { relPath: string; index: number }[] = [
  { relPath: 'wd_.code-workspace_073f548f415a/session_787c5c32-6420-4742-8614-d456aa6bef4f/agents/main', index: 41 },
  { relPath: 'wd_kimi-code-di-v4_e5415428af7c/session_18d1e696-c7d1-49f9-81c3-d1e3446f9f75/agents/main', index: 5 },
  { relPath: 'wd_openclaw_a1dc20dc2ea8/session_00636111-25bb-4a2b-b7de-7d67993db403/agents/main', index: 0 },
  { relPath: 'wd_kimi-code-di-v3_bfc63729a762/session_13ea953e-27a6-4905-b204-55fbc4410a91/agents/main', index: 25 },
];

function fieldDiff(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, { r1: unknown; r2: unknown }> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff: Record<string, { r1: unknown; r2: unknown }> = {};
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      diff[key] = { r1: a[key], r2: b[key] };
    }
  }
  return diff;
}

function originalFirstRecordType(relPath: string): string | undefined {
  const file = join(SESSIONS, relPath, 'wire.jsonl');
  try {
    const lines = require('node:fs').readFileSync(file, 'utf8').split('\n').filter((l: string) => l.length > 0);
    const meta = JSON.parse(lines[0]);
    return `metadata.protocol_version=${meta.protocol_version}, firstDataRecord=${lines[1] ? JSON.parse(lines[1]).type : '(none)'}`;
  } catch (e) {
    return `read-error: ${String(e)}`;
  }
}

describe('resume round-trip diff diagnosis', () => {
  it('prints field-level diff at the first diverging record', async () => {
    const bootstrap = stubBootstrap(DST);
    const storage = new FileStorageService(DST);
    const ix = new TestInstantiationService();
    ix.stub(IFileSystemStorageService, storage);
    ix.stub(IBootstrapService, bootstrap);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = ix.get(IAppendLogStore) as InstanceType<typeof AppendLogStore>;

    for (const { relPath, index } of TARGETS) {
      const agentHomedir = join(SESSIONS, relPath);
      console.log('\n==================================================');
      console.log(`target: ${relPath}  (firstDiff@${index})`);
      console.log(`original: ${originalFirstRecordType(relPath)}`);

      const wire1 = new AgentWireRecordService({ homedir: agentHomedir }, bootstrap, undefined, log);
      await wire1.restore();
      const r1 = wire1.getRecords();

      const redumpHomedir = join(REDUMP, relPath);
      const redumpFile = join(redumpHomedir, 'wire.jsonl');
      mkdirSync(dirname(redumpFile), { recursive: true });
      writeFileSync(
        redumpFile,
        [
          JSON.stringify({ type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 }),
          ...r1.map((record) => JSON.stringify(record)),
        ].join('\n') + '\n',
      );

      const wire2 = new AgentWireRecordService({ homedir: redumpHomedir }, bootstrap, undefined, log);
      await wire2.restore();
      const r2 = wire2.getRecords();

      expect(r2.length).toBe(r1.length);

      const a = r1[index] as Record<string, unknown> | undefined;
      const b = r2[index] as Record<string, unknown> | undefined;
      if (a === undefined || b === undefined) {
        console.log(`r1[${index}] type=${String(a?.['type'])}, r2[${index}] type=${String(b?.['type'])} (one side undefined)`);
        continue;
      }
      const diff = fieldDiff(a, b);
      console.log(`r1[${index}].type=${String(a['type'])}, r2[${index}].type=${String(b['type'])}`);
      console.log(`changed fields: ${Object.keys(diff).join(', ') || '(none)'}`);
      for (const [key, value] of Object.entries(diff)) {
        console.log(`--- field "${key}" ---`);
        console.log('r1:', JSON.stringify(value.r1)?.slice(0, 600));
        console.log('r2:', JSON.stringify(value.r2)?.slice(0, 600));
      }
    }
  }, 120_000);
});
