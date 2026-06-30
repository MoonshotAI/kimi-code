import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';
import { ZipFile } from 'yazl';

import { importsRoute } from '../../src/routes/imports';
import { logsRoute } from '../../src/routes/logs';
import { sessionsRoute } from '../../src/routes/sessions';
import { wireRoute } from '../../src/routes/wire';

function buildZip(entries: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data, 'utf8'), name);
    zip.end();
    const chunks: Buffer[] = [];
    (zip.outputStream as NodeJS.ReadableStream).on('data', (c: Buffer) => chunks.push(c));
    (zip.outputStream as NodeJS.ReadableStream).on('end', () => { resolve(Buffer.concat(chunks)); });
    (zip.outputStream as NodeJS.ReadableStream).on('error', reject);
  });
}

const META = JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1 });
const PROMPT = JSON.stringify({ type: 'turn.prompt', time: 2, input: [{ type: 'text', text: 'hi' }], origin: { kind: 'user' } });

function bundle(): Record<string, string> {
  return {
    'manifest.json': JSON.stringify({ sessionId: 'session_orig', kimiCodeVersion: '0.20.2', workspaceDir: '/w/proj', title: 'demo' }),
    'state.json': JSON.stringify({ createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T01:00:00.000Z', title: 'demo', agents: { main: { homedir: '/orig/agents/main', type: 'main', parentAgentId: null } }, custom: {} }),
    'agents/main/wire.jsonl': `${META}\n${PROMPT}\n`,
    'logs/kimi-code.log': '2026-06-01T00:00:00.000Z INFO  boot  step=0\n2026-06-01T00:00:01.000Z ERROR  oops  code=500\n',
  };
}

async function importBundle(home: string): Promise<string> {
  const app = importsRoute(home);
  const res = await app.request('/?name=demo.zip', { method: 'POST', body: await buildZip(bundle()) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

describe('imports + logs routes', () => {
  let home: string | null = null;
  afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = null; });

  it('imports a zip and surfaces it in the session list tagged imported', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-imp-route-'));
    const importId = await importBundle(home);

    const list = sessionsRoute(home);
    const res = await list.request('/');
    const body = (await res.json()) as { sessions: { sessionId: string; imported: boolean; importMeta: { manifest: { kimiCodeVersion: string } | null } | null }[] };
    const imported = body.sessions.find((s) => s.sessionId === importId);
    expect(imported).toBeDefined();
    expect(imported!.imported).toBe(true);
    expect(imported!.importMeta?.manifest?.kimiCodeVersion).toBe('0.20.2');
  });

  it('serves the imported session wire through the existing wire route', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-imp-route-'));
    const importId = await importBundle(home);
    const res = await wireRoute(home).request(`/${importId}/wire?agent=main`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { data: { type: string } }[] };
    // metadata is the wire header; the one remaining record is the prompt.
    expect(body.records.length).toBeGreaterThanOrEqual(1);
    expect(body.records.some((r) => r.data.type === 'turn.prompt')).toBe(true);
  });

  it('parses the imported session log', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-imp-route-'));
    const importId = await importBundle(home);
    const res = await logsRoute(home).request(`/${importId}/logs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: { session: boolean }; lines: { level: string | null; fields: Record<string, string> }[] };
    expect(body.available.session).toBe(true);
    expect(body.lines).toHaveLength(2);
    expect(body.lines[1]!.level).toBe('ERROR');
    expect(body.lines[1]!.fields).toEqual({ code: '500' });
  });

  it('rejects a non-zip upload with 400', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-imp-route-'));
    const res = await importsRoute(home).request('/', { method: 'POST', body: Buffer.from('not a zip') });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an empty upload with 400', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-imp-route-'));
    const res = await importsRoute(home).request('/', { method: 'POST', body: Buffer.alloc(0) });
    expect(res.status).toBe(400);
  });

  it('falls back to disk agent discovery when an imported bundle state omits agents', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-imp-route-'));
    // Readable state.json, but no `agents` map (best-effort bundle). The main
    // wire is present on disk, so the agent must still be discoverable.
    const noAgents: Record<string, string> = {
      'manifest.json': JSON.stringify({ sessionId: 'session_orig' }),
      'state.json': JSON.stringify({ createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T01:00:00.000Z', title: 'demo', custom: {} }),
      'agents/main/wire.jsonl': `${META}\n${PROMPT}\n`,
    };
    const importRes = await importsRoute(home).request('/?name=x.zip', { method: 'POST', body: await buildZip(noAgents) });
    expect(importRes.status).toBe(200);
    const importId = ((await importRes.json()) as { sessionId: string }).sessionId;

    // Despite the empty state.agents, the wire route resolves `main` via disk.
    const wireRes = await wireRoute(home).request(`/${importId}/wire?agent=main`);
    expect(wireRes.status).toBe(200);
    expect(((await wireRes.json()) as { records: unknown[] }).records.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to disk discovery when an imported agents map is type-corrupt', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-imp-route-'));
    // state.json present, agents map non-empty but the entry is null — must not
    // 500; the on-disk main wire should still be discoverable.
    const corruptAgents: Record<string, string> = {
      'manifest.json': JSON.stringify({ sessionId: 'session_orig' }),
      'state.json': JSON.stringify({ createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T01:00:00.000Z', title: 'demo', agents: { main: null }, custom: {} }),
      'agents/main/wire.jsonl': `${META}\n${PROMPT}\n`,
    };
    const importId = ((await (await importsRoute(home).request('/?name=x.zip', { method: 'POST', body: await buildZip(corruptAgents) })).json()) as { sessionId: string }).sessionId;

    const wireRes = await wireRoute(home).request(`/${importId}/wire?agent=main`);
    expect(wireRes.status).toBe(200);
    expect(((await wireRes.json()) as { records: unknown[] }).records.length).toBeGreaterThanOrEqual(1);
  });

  it('sanitizes type-corrupt manifest fields so the session list cannot crash', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-imp-route-'));
    const corrupt: Record<string, string> = {
      // workspaceDir / kimiCodeVersion are the wrong type — must not reach workDir.
      'manifest.json': JSON.stringify({ sessionId: 'session_orig', workspaceDir: 123, kimiCodeVersion: 7, title: 'demo' }),
      'state.json': JSON.stringify({ createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T01:00:00.000Z', title: 'demo', agents: { main: { homedir: '/o', type: 'main', parentAgentId: null } }, custom: {} }),
      'agents/main/wire.jsonl': `${META}\n${PROMPT}\n`,
    };
    const importId = ((await (await importsRoute(home).request('/?name=x.zip', { method: 'POST', body: await buildZip(corrupt) })).json()) as { sessionId: string }).sessionId;

    const body = (await (await sessionsRoute(home).request('/')).json()) as {
      sessions: { sessionId: string; workDir: unknown; importMeta: { manifest: { workspaceDir?: unknown; kimiCodeVersion?: unknown; sessionId?: unknown } | null } | null }[];
    };
    const s = body.sessions.find((x) => x.sessionId === importId)!;
    expect(typeof s.workDir).toBe('string'); // not the number 123
    expect(s.workDir).toBe('');
    expect(s.importMeta?.manifest?.workspaceDir).toBeUndefined(); // dropped
    expect(s.importMeta?.manifest?.kimiCodeVersion).toBeUndefined(); // dropped
    expect(s.importMeta?.manifest?.sessionId).toBe('session_orig'); // valid string kept
  });
});
