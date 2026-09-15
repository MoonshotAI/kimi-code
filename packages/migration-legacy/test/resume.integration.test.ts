import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';
import { reduceContextTranscript } from '@moonshot-ai/agent-core-v2';
import { groupMessagesIntoSnapshot } from '@moonshot-ai/transcript';

import { migrateOneSession, type MigrateOneResult } from '../src/sessions/migrate-one.js';
import { computeWorkdirBucket } from '../src/sessions/workdir-bucket.js';
import { listSessionsV2, readSessionSummaryV2 } from './v2-session-scan.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const WORK_DIR = '/Users/example/proj';

let targetHome: string;
beforeEach(async () => {
  targetHome = await mkdtemp(join(tmpdir(), 'resume-integ-'));
});
afterEach(async () => {
  await rm(targetHome, { recursive: true, force: true });
});

async function migrateFixture(
  uuid: string,
  fixture: string,
): Promise<Extract<MigrateOneResult, { outcome: 'migrated' }>> {
  const result = await migrateOneSession({
    source: {
      uuid,
      sessionDir: join(FIXTURES, fixture),
      contextPath: join(join(FIXTURES, fixture), 'context.jsonl'),
    },
    workdirPath: WORK_DIR,
    targetHome,
  });
  expect(result.outcome).toBe('migrated');
  return result as Extract<MigrateOneResult, { outcome: 'migrated' }>;
}

describe('migrated session is discoverable by agent-core-v2', () => {
  it('computeWorkdirBucket matches v2 encodeWorkDirKey', () => {
    expect(computeWorkdirBucket(WORK_DIR)).toBe(encodeWorkDirKey(WORK_DIR));
  });

  it('v2 authoritative scan finds a migrated session under the same workDir', async () => {
    await migrateFixture('integ-uuid', 'with-tool-calls');

    const sessions = await listSessionsV2(targetHome);
    const migrated = sessions.find((s) => s.id === 'ses_integ-uuid');
    expect(migrated).toBeDefined();
    expect(migrated?.custom?.['imported_from_kimi_cli']).toBe(true);
    expect(migrated?.cwd).toBe(WORK_DIR);
  });

  it('migrated wire history is non-empty', async () => {
    const result = await migrateFixture('tiny-resume', 'tiny-hello-world');

    const wire = await readFile(join(result.targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const events = wire
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(events[0]?.type).toBe('metadata');
    expect(events.filter((e) => e.type === 'context.append_message').length).toBeGreaterThan(0);
  });

  it('v2 summary exposes the migrated title, metadata and message history', async () => {
    const result = await migrateFixture('tiny-resume', 'tiny-hello-world');

    const summary = await readSessionSummaryV2(targetHome, 'ses_tiny-resume');
    expect(summary).toBeDefined();
    expect(summary?.title).toBe('hi');
    expect(summary?.cwd).toBe(WORK_DIR);
    expect(summary?.archived).toBe(false);
    expect(summary?.createdAt).toBeGreaterThan(0);

    const wire = await readFile(join(result.targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    expect(wire).toContain('hi');
    expect(wire).toContain('Hello! How can I help?');
  });

  it('v2 scan lists a title-only migrated session with its custom title', async () => {
    await migrateFixture('title-only-resume', 'title-only');

    const summary = await readSessionSummaryV2(targetHome, 'ses_title-only-resume');
    expect(summary).toBeDefined();
    expect(summary?.title).toBe('My named session');
  });

  it('migrated wire preserves a legacy todo display', async () => {
    const result = await migrateFixture('todo-display', 'large-100msgs');

    const wire = await readFile(join(result.targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    expect(wire).toContain('tool_y3SXWWQIUysddnYoklaWhUeE');
    expect(wire).toContain('todo_list');
    expect(wire).toContain('准备测试环境（创建隔离 work-dir）');
    expect(wire).toContain('汇报结论');
  });

  it('turn structure survives a v2 context-transcript round trip and aligns with transcript grouping', async () => {
    const result = await migrateFixture('turn-structure', 'with-tool-calls');

    const wire = await readFile(join(result.targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const records = wire
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; [key: string]: unknown });

    // Content round trip: the v2 context transcript sees exactly the imported
    // messages — the synthesized turn records must not alter, duplicate, or
    // drop any message. (`toolCallDisplays` is UI-only enrichment the context
    // transcript deliberately does not carry, so strip it from both sides.)
    const transcript = reduceContextTranscript(records);
    const imported = records
      .filter((r) => r.type === 'context.append_message')
      .map((r) => r['message']);
    const stripDisplays = (
      messages: readonly unknown[],
    ): unknown[] =>
      messages.map((m) => {
        const { toolCallDisplays: _dropped, ...rest } = m as Record<string, unknown>;
        return rest;
      });
    expect(stripDisplays([...transcript.entries])).toEqual(stripDisplays(imported));

    // The invariant that keeps a live turn from hijacking an imported one:
    // every turn.prompt advances the restored turn clock by one, so the number
    // of synthesized turn.prompt records must equal the number of turns the
    // transcript grouping derives from the same messages. The first live turn
    // after resume then gets an id past every imported turn.
    const promptCount = records.filter((r) => r.type === 'turn.prompt').length;
    const groupedTurns = groupMessagesIntoSnapshot([...transcript.entries]).items.filter(
      (item) => item.kind === 'turn',
    ).length;
    expect(promptCount).toBe(groupedTurns);
    expect(promptCount).toBeGreaterThan(0);

    const endedTurnIds = records
      .filter((r) => r.type === 'turn.ended')
      .map((r) => r['turnId'])
      .filter((id): id is number => typeof id === 'number');
    // Turns without assistant content (e.g. an unanswered user message) get no
    // turn.ended; the rest carry sequential ids within the imported range.
    expect(endedTurnIds).toEqual([...endedTurnIds].sort((a, b) => a - b));
    expect(new Set(endedTurnIds).size).toBe(endedTurnIds.length);
    expect(Math.max(...endedTurnIds)).toBeLessThan(promptCount);
  });
});
