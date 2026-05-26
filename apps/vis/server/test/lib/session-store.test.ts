// apps/vis/server/test/lib/session-store.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { buildSessionFixture } from '../fixtures/build';
import { listSessions, readSessionDetail } from '../../src/lib/session-store';

describe('session-store', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('lists native session with correct timestamps and counts', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const sessions = await listSessions(home);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.sessionId).toBe('session_fixture');
    expect(s.title).toBe('fixture: hello world');
    expect(s.lastPrompt).toBe('say hi');
    expect(s.agentCount).toBe(2);
    expect(s.mainAgentExists).toBe(true);
    expect(s.mainWireRecordCount).toBe(11);  // 11 lines in main wire incl. metadata
    expect(s.wireProtocolVersion).toBe('1.1');
    expect(s.health).toBe('ok');
    expect(s.workDir).toBe('/tmp/work');
    expect(s.createdAt).toBe(Date.parse('2026-05-20T05:59:51.085Z'));
    expect(s.updatedAt).toBe(Date.parse('2026-05-21T03:12:08.000Z'));
  });

  it('falls back to empty workDir when session is not in the index', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(home, 'session_index.jsonl'));
    const sessions = await listSessions(home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.workDir).toBe('');
  });

  it('skips imported_from_kimi_cli sessions', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    // mark as imported
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const state = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8'));
    state.custom = { imported_from_kimi_cli: true };
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify(state));
    const sessions = await listSessions(home);
    expect(sessions).toHaveLength(0);
  });

  it('reads session detail with full agent inventory', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const d = await readSessionDetail(home, 'session_fixture');
    expect(d).not.toBeNull();
    expect(d!.workDir).toBe('/tmp/work');
    expect(d!.agents.map((a) => a.agentId).sort()).toEqual(['agent-0', 'main']);
    const main = d!.agents.find((a) => a.agentId === 'main')!;
    expect(main.type).toBe('main');
    expect(main.parentAgentId).toBeNull();
    expect(main.wireExists).toBe(true);
    expect(main.wireRecordCount).toBe(11);
    const sub = d!.agents.find((a) => a.agentId === 'agent-0')!;
    expect(sub.parentAgentId).toBe('main');
  });
});
