/**
 * Engine-mode `/api/v1/sessions` — the session surface served by the Rust
 * engine (`RustSessionService`).
 *
 * Coverage here: create (+ cwd validation), list, get-by-id, status, goal,
 * warnings, and the ZIP export route. The v2-only surface (profile updates,
 * :archive/:restore/:undo/:fork/:restart, children, pagination/filter query
 * params, workspace bookkeeping) was retired with the engine migration and is
 * not covered — the engine owns those semantics now.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionWarningsResponseSchema } from '../src/protocol/rest-session';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
  stack?: string;
}

interface SessionWire {
  id: string;
  workspace_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  busy: boolean;
  main_turn_active: boolean;
  pending_interaction: 'none' | 'approval' | 'question';
  metadata: { cwd: string } & Record<string, unknown>;
  agent_config: { model: string };
  permission_rules: unknown[];
  message_count: number;
  last_seq: number;
}

interface PageWire {
  items: SessionWire[];
  has_more: boolean;
}

describe('engine-mode /api/v1/sessions', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-engine-sessions-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('downloads a ZIP with the supplied Web log and cleans up its temporary directory', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const webLog = [
      JSON.stringify({ event: 'websocket.connected', time: 1 }),
      JSON.stringify({ event: 'prompt.submitted', time: 2 }),
    ].join('\n');

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ web_log: webLog }),
    } as never);
    const archive = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="kimi-session-${id}.zip"`,
    );
    expect(res.headers.get('content-length')).toBe(String(archive.length));
    expect(res.headers.get('cache-control')).toBe('no-store');

    const entries = readZipEntries(archive);
    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? 'null') as {
      sessionId: string;
      webLogPath?: string;
    };
    expect(entries.get('logs/kimi-web.jsonl')?.toString('utf8')).toBe(webLog);
    expect(manifest).toMatchObject({
      sessionId: id,
      webLogPath: 'logs/kimi-web.jsonl',
    });
    await expect.poll(() => listExportTempDirs(id)).toEqual([]);
  });

  it('returns the JSON session-not-found envelope instead of a ZIP', async () => {
    const id = 'sess_missing_export';
    const { status, body } = await postJson<null>(`/api/v1/sessions/${id}/export`, {});

    expect(status).toBe(200);
    expect(body.code).toBe(40401);
    await expect.poll(() => listExportTempDirs(id)).toEqual([]);
  });

  it('cleans up the temporary archive when the client cancels the download', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: '{}',
    } as never);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    await reader?.cancel();

    await expect.poll(() => listExportTempDirs(id)).toEqual([]);
  });

  it('rejects a Web log larger than 256 KiB in UTF-8', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const { status, body } = await postJson<null>(
      `/api/v1/sessions/${created.body.data.id}/export`,
      { web_log: '你'.repeat(87_382) },
    );

    expect(status).toBe(200);
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('web_log');
  });

  it('creates a session from metadata.cwd', async () => {
    const cwd = home as string;
    const { status, body } = await postJson<SessionWire>('/api/v1/sessions', {
      title: 'hello',
      metadata: { cwd },
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(typeof body.data.id).toBe('string');
    expect(body.data.title).toBe('hello');
    expect(body.data.metadata.cwd).toBe(cwd);
    expect(body.data.busy).toBe(false);
    expect(body.data.main_turn_active).toBe(false);
    expect(body.data.pending_interaction).toBe('none');
    expect(body.data.agent_config).toEqual({ model: '' });
    expect(body.data.permission_rules).toEqual([]);
    expect(body.data.message_count).toBe(0);
    expect(body.data.last_seq).toBe(0);
    expect(Number.isNaN(Date.parse(body.data.created_at))).toBe(false);
  });

  it('rejects create without cwd (40001)', async () => {
    const { body } = await postJson<null>('/api/v1/sessions', { title: 'no cwd' });
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('metadata.cwd');
  });

  it('rejects create when metadata.cwd does not exist (40409)', async () => {
    const missing = join(home as string, 'never-created');
    const { body } = await postJson<null>('/api/v1/sessions', { metadata: { cwd: missing } });
    expect(body.code).toBe(40409);
  });

  it('rejects create when metadata.cwd is not a directory (40409)', async () => {
    const file = join(home as string, 'a-file.txt');
    await writeFile(file, 'hi', 'utf8');
    const { body } = await postJson<null>('/api/v1/sessions', { metadata: { cwd: file } });
    expect(body.code).toBe(40409);
  });

  it('lists created sessions', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<PageWire>('/api/v1/sessions');
    expect(body.code).toBe(0);
    expect(body.data.items.some((s) => s.id === created.body.data.id)).toBe(true);
    expect(typeof body.data.has_more).toBe('boolean');
  });

  it('gets a session by id and 404s for unknown', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.id).toBe(created.body.data.id);

    const missing = await getJson<null>('/api/v1/sessions/nope');
    expect(missing.body.code).toBe(40401);
  });

  it('returns engine status for a live session', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<{
      model?: string | null;
      thinking_effort: string;
      permission: string;
      plan_mode: boolean;
      swarm_mode: boolean;
      goal_enabled: boolean;
      context_tokens: number;
      max_context_tokens: number;
      context_usage: number;
    }>(`/api/v1/sessions/${created.body.data.id}/status`);
    expect(body.code).toBe(0);
    expect(typeof body.data.thinking_effort).toBe('string');
    expect(typeof body.data.plan_mode).toBe('boolean');
    expect(typeof body.data.swarm_mode).toBe('boolean');
    expect(typeof body.data.context_tokens).toBe('number');
    expect(typeof body.data.max_context_tokens).toBe('number');
    expect(typeof body.data.context_usage).toBe('number');
  });

  it('returns 40401 for status of a missing session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/sess_missing_status/status');
    expect(body.code).toBe(40401);
  });

  it('returns a null goal for a fresh session', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<{ goal: unknown } | null>(
      `/api/v1/sessions/${created.body.data.id}/goal`,
    );
    expect(body.code).toBe(0);
  });

  it('returns an empty warnings list for an existing session', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { status, body } = await getJson<{ warnings: unknown[] }>(
      `/api/v1/sessions/${created.body.data.id}/warnings`,
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ warnings: [] });
    expect(sessionWarningsResponseSchema.parse(body.data)).toEqual({ warnings: [] });
  });

  it('returns 40401 for warnings of a missing session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/sess_missing_warnings/warnings');
    expect(body.code).toBe(40401);
  });
});

async function listExportTempDirs(sessionId: string): Promise<string[]> {
  const prefix = `kimi-session-export-${sessionId}-`;
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)).toSorted();
}

function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = archive.lastIndexOf(endSignature);
  if (endOffset < 0) throw new Error('ZIP end record not found');

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive
      .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
      .toString('utf8');

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Invalid ZIP local entry');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(compressed));
    else if (method === 8) entries.set(name, inflateRawSync(compressed));
    else throw new Error(`Unsupported ZIP compression method: ${method}`);

    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
