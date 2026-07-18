import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionApprovalService, ISessionLifecycleService } from '@moonshot-ai/agent-core-v2';
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

interface ApprovalWire {
  approval_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display: unknown;
  created_at: string;
  expires_at: string;
}

interface ListWire {
  items: ApprovalWire[];
}

interface ResolveWire {
  resolved: true;
  resolved_at: string;
}

describe('server-v2 /api/v1/sessions/{sid}/approvals', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-approvals-'));
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

  /** Park an approval in-process so the REST route has something to list/resolve. */
  function enqueueApproval(sessionId: string, toolCallId: string): string {
    const handle = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    expect(handle).toBeDefined();
    const parked = handle!.accessor.get(ISessionApprovalService).enqueue({
      toolCallId,
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'command', command: 'echo hi' },
    });
    return parked.id;
  }

  it('lists a pending approval projected onto the wire shape', async () => {
    const sid = await createSession();
    const aid = enqueueApproval(sid, 'tc-1');

    const { body } = await getJson<ListWire>(`/api/v1/sessions/${sid}/approvals?status=pending`);
    expect(body.code).toBe(0);
    expect(body.data.items).toHaveLength(1);
    const item = body.data.items[0]!;
    expect(item.approval_id).toBe(aid);
    expect(item.session_id).toBe(sid);
    expect(item.tool_call_id).toBe('tc-1');
    expect(item.tool_name).toBe('Bash');
    expect(item.action).toBe('run');
    expect(item.tool_input_display).toEqual({ kind: 'command', command: 'echo hi' });
    expect(Number.isNaN(Date.parse(item.created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(item.expires_at))).toBe(false);
  });

  it('resolves a pending approval', async () => {
    const sid = await createSession();
    const aid = enqueueApproval(sid, 'tc-2');

    const { body } = await postJson<ResolveWire>(`/api/v1/sessions/${sid}/approvals/${aid}`, {
      decision: 'approved',
    });
    expect(body.code).toBe(0);
    expect(body.data.resolved).toBe(true);
    expect(Number.isNaN(Date.parse(body.data.resolved_at))).toBe(false);

    const listed = await getJson<ListWire>(`/api/v1/sessions/${sid}/approvals?status=pending`);
    expect(listed.body.data.items).toHaveLength(0);
  });

  it('returns 40902 on a duplicate resolve (recently-resolved window)', async () => {
    const sid = await createSession();
    const aid = enqueueApproval(sid, 'tc-3');
    await postJson<ResolveWire>(`/api/v1/sessions/${sid}/approvals/${aid}`, {
      decision: 'approved',
    });

    const dup = await postJson<{ resolved: false }>(`/api/v1/sessions/${sid}/approvals/${aid}`, {
      decision: 'approved',
    });
    expect(dup.body.code).toBe(40902);
    expect(dup.body.data).toEqual({ resolved: false });
  });

  it('returns 40404 for an unknown approval id', async () => {
    const sid = await createSession();
    const { body } = await postJson<null>(`/api/v1/sessions/${sid}/approvals/nope`, {
      decision: 'rejected',
    });
    expect(body.code).toBe(40404);
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/nope/approvals?status=pending');
    expect(body.code).toBe(40401);
  });
});
