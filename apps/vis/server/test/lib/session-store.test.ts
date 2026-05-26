// apps/vis/server/test/lib/session-store.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { buildSessionFixture } from '../fixtures/build';
import { isSafeAgentId, listSessions, readSessionDetail } from '../../src/lib/session-store';

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
    expect(s.mainWireRecordCount).toBe(10);  // 10 lines in main wire incl. metadata
    expect(s.wireProtocolVersion).toBe('1.1');
    expect(s.health).toBe('ok');
    expect(s.workDir).toBe('/tmp/work');
    expect(s.createdAt).toBe(Date.parse('2026-05-20T05:59:51.085Z'));
    expect(s.updatedAt).toBe(Date.parse('2026-05-21T03:12:08.000Z'));
  });

  it('treats a v1.0 wire as healthy (vis migrates on read)', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const lines = (await readFile(wirePath, 'utf8')).split('\n');
    lines[0] = JSON.stringify({ type: 'metadata', protocol_version: '1.0', created_at: 1 });
    await writeFile(wirePath, lines.join('\n'));
    const sessions = await listSessions(home);
    expect(sessions[0]!.health).toBe('ok');
    expect(sessions[0]!.wireProtocolVersion).toBe('1.0');
  });

  it('treats unknown protocol versions as healthy (wire-reader best-efforts)', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const lines = (await readFile(wirePath, 'utf8')).split('\n');
    lines[0] = JSON.stringify({ type: 'metadata', protocol_version: '2.2', created_at: 1 });
    await writeFile(wirePath, lines.join('\n'));
    const sessions = await listSessions(home);
    expect(sessions[0]!.health).toBe('ok');
    expect(sessions[0]!.wireProtocolVersion).toBe('2.2');
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

  it('marks a session broken_main_wire when its wire file cannot be scanned', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const { rm, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // Replace the wire FILE with a directory of the same name, so the
    // createReadStream below will reject with EISDIR.
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    await rm(wirePath);
    await mkdir(wirePath);
    const sessions = await listSessions(home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.health).toBe('broken_main_wire');
    expect(sessions[0]!.mainWireRecordCount).toBe(0);
  });

  it('marks a session broken_main_wire when the wire metadata header is malformed', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    // First line is not a `metadata` record — list health used to stay
    // 'ok' while readAgentWire would fail on open.
    await writeFile(
      wirePath,
      '{"type":"config.update","cwd":"/x","time":1}\n',
    );
    const sessions = await listSessions(home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.health).toBe('broken_main_wire');
  });

  it('rejects unsafe agent ids', () => {
    expect(isSafeAgentId('main')).toBe(true);
    expect(isSafeAgentId('agent-0')).toBe(true);
    expect(isSafeAgentId('agent_0.v2')).toBe(true);
    expect(isSafeAgentId('..')).toBe(false);
    expect(isSafeAgentId('.')).toBe(false);
    expect(isSafeAgentId('../foo')).toBe(false);
    expect(isSafeAgentId('a/b')).toBe(false);
    expect(isSafeAgentId('a\\b')).toBe(false);
    expect(isSafeAgentId('')).toBe(false);
  });

  it('skips unsafe agent ids from state.json in the inventory', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const statePath = join(sessionDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.agents['../escape'] = {
      homedir: '/tmp/whatever',
      type: 'sub',
      parentAgentId: 'main',
    };
    await writeFile(statePath, JSON.stringify(state));
    // Plant a wire file under the "../escape" path that would be
    // reachable if isSafeAgentId failed to gate path joins.
    await mkdir(join(sessionDir, '..', 'escape'), { recursive: true });
    await writeFile(
      join(sessionDir, '..', 'escape', 'wire.jsonl'),
      '{"type":"metadata","protocol_version":"1.1","created_at":1}\n',
    );
    const d = await readSessionDetail(home, 'session_fixture');
    expect(d!.agents.map((a) => a.agentId).sort()).toEqual(['agent-0', 'main']);
  });

  it('rejects session_index entries that point outside KIMI_CODE_HOME', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // Poison the index: claim session_fixture lives at /tmp/elsewhere.
    const elsewhere = '/tmp/vis-poison-test-' + Date.now();
    await mkdir(elsewhere, { recursive: true });
    await writeFile(
      join(home, 'session_index.jsonl'),
      JSON.stringify({
        sessionId: 'session_fixture',
        sessionDir: elsewhere,
        workDir: '/somewhere',
      }) + '\n',
    );
    // Detail must fall back to bucket scanning (legit path under home)
    // rather than honour the poisoned index entry.
    const d = await readSessionDetail(home, 'session_fixture');
    expect(d).not.toBeNull();
    expect(d!.sessionDir.startsWith(home)).toBe(true);
    const { rm } = await import('node:fs/promises');
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('reports an unreadable subagent wire as wireExists=false in agent inventory', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // Break the SUBAGENT's wire metadata; main wire stays intact so the
    // session itself remains healthy.
    await writeFile(
      join(sessionDir, 'agents', 'agent-0', 'wire.jsonl'),
      'not even json\n',
    );
    const d = await readSessionDetail(home, 'session_fixture');
    expect(d).not.toBeNull();
    const sub = d!.agents.find((a) => a.agentId === 'agent-0')!;
    expect(sub.wireExists).toBe(false);
    expect(sub.wireRecordCount).toBe(0);
  });

  it('exposes the canonical session directory in detail responses', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const d = await readSessionDetail(home, 'session_fixture');
    expect(d!.sessionDir).toBe(sessionDir);
  });

  it('returns broken-state detail consistent with the listed broken summary', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(sessionDir, 'state.json'), '{ this is not json');
    const summaries = await listSessions(home);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.health).toBe('broken_state');
    const d = await readSessionDetail(home, 'session_fixture');
    expect(d).not.toBeNull();
    expect(d!.state).toBeNull();
    expect(d!.workDir).toBe('/tmp/work');
    // Even with state.json broken, the on-disk agent directories should
    // still be inventoried so users can open wire/context.
    expect(d!.agents.map((a) => a.agentId).sort()).toEqual(['agent-0', 'main']);
    const main = d!.agents.find((a) => a.agentId === 'main')!;
    expect(main.wireExists).toBe(true);
    expect(main.wireRecordCount).toBe(10);
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
    expect(main.wireRecordCount).toBe(10);
    const sub = d!.agents.find((a) => a.agentId === 'agent-0')!;
    expect(sub.parentAgentId).toBe('main');
  });
});
