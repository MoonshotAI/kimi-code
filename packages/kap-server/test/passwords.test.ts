import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionLifecycleService, ISessionPasswordService } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface PasswordWire {
  id: string;
  session_id: string;
  prompt: string;
  command?: string;
}

interface ListWire {
  items: PasswordWire[];
}

interface ResolveWire {
  resolved: true;
  resolved_at: string;
}

interface SnapshotWire {
  pending_passwords: PasswordWire[];
}

describe('server-v2 /api/v1/sessions/{sid}/passwords', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-passwords-'));
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
      await rm(home, { recursive: true, force: true });
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

  async function createSession(): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  /** Park a password request in-process so the REST route has something to list/resolve. */
  function enqueuePassword(sessionId: string, prompt: string, command?: string): string {
    const handle = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    expect(handle).toBeDefined();
    const parked = handle!.accessor.get(ISessionPasswordService).enqueue({ prompt, command });
    return parked.id;
  }

  it('lists a pending password request projected onto the wire shape', async () => {
    const sid = await createSession();
    const pid = enqueuePassword(sid, '[sudo] password for user: ', 'sudo cat /etc/shadow');

    const { body } = await getJson<ListWire>(`/api/v1/sessions/${sid}/passwords`);
    expect(body.code).toBe(0);
    expect(body.data.items).toHaveLength(1);
    const item = body.data.items[0]!;
    expect(item).toEqual({
      id: pid,
      session_id: sid,
      prompt: '[sudo] password for user: ',
      command: 'sudo cat /etc/shadow',
    });
  });

  it('resolves a pending password request with a submitted password', async () => {
    const sid = await createSession();
    const pid = enqueuePassword(sid, 'Password: ');

    const { body } = await postJson<ResolveWire>(`/api/v1/sessions/${sid}/passwords/${pid}`, {
      password: 'hunter2',
    });
    expect(body.code).toBe(0);
    expect(body.data.resolved).toBe(true);
    expect(Number.isNaN(Date.parse(body.data.resolved_at))).toBe(false);
    // The envelope must never echo the password back.
    expect(JSON.stringify(body)).not.toContain('hunter2');

    const listed = await getJson<ListWire>(`/api/v1/sessions/${sid}/passwords`);
    expect(listed.body.data.items).toHaveLength(0);
  });

  it('resolves a pending password request as cancelled', async () => {
    const sid = await createSession();
    const pid = enqueuePassword(sid, 'Password: ');

    const { body } = await postJson<ResolveWire>(`/api/v1/sessions/${sid}/passwords/${pid}`, {
      cancelled: true,
    });
    expect(body.code).toBe(0);
    expect(body.data.resolved).toBe(true);
  });

  it('rejects a malformed resolve body with 40001', async () => {
    const sid = await createSession();
    const pid = enqueuePassword(sid, 'Password: ');

    const { body } = await postJson<null>(`/api/v1/sessions/${sid}/passwords/${pid}`, {});
    expect(body.code).toBe(40001);
  });

  it('returns 40902 on a duplicate resolve (recently-resolved window)', async () => {
    const sid = await createSession();
    const pid = enqueuePassword(sid, 'Password: ');
    await postJson<ResolveWire>(`/api/v1/sessions/${sid}/passwords/${pid}`, {
      password: 'hunter2',
    });

    const dup = await postJson<{ resolved: false }>(`/api/v1/sessions/${sid}/passwords/${pid}`, {
      password: 'hunter2',
    });
    expect(dup.body.code).toBe(40902);
    expect(dup.body.data).toEqual({ resolved: false });
  });

  it('returns 40417 for an unknown password id', async () => {
    const sid = await createSession();
    const { body } = await postJson<null>(`/api/v1/sessions/${sid}/passwords/nope`, {
      password: 'hunter2',
    });
    expect(body.code).toBe(40417);
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/nope/passwords');
    expect(body.code).toBe(40401);
  });

  it('exposes pending password requests in the session snapshot, never the password', async () => {
    const sid = await createSession();
    const pid = enqueuePassword(sid, '[sudo] password for user: ', 'sudo ls');

    const pending = await getJson<SnapshotWire>(`/api/v1/sessions/${sid}/snapshot`);
    expect(pending.body.code).toBe(0);
    expect(pending.body.data.pending_passwords).toEqual([
      { id: pid, session_id: sid, prompt: '[sudo] password for user: ', command: 'sudo ls' },
    ]);

    // Resolve with a real password, then re-read every surface: the secret
    // must not appear in the snapshot or the list.
    await postJson<ResolveWire>(`/api/v1/sessions/${sid}/passwords/${pid}`, {
      password: 'hunter2',
    });
    const after = await getJson<SnapshotWire>(`/api/v1/sessions/${sid}/snapshot`);
    expect(after.body.data.pending_passwords).toEqual([]);
    expect(JSON.stringify(after.body)).not.toContain('hunter2');
    const listed = await getJson<ListWire>(`/api/v1/sessions/${sid}/passwords`);
    expect(JSON.stringify(listed.body)).not.toContain('hunter2');
  });
});
