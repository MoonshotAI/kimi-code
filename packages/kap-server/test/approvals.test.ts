import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { randomUUID } from 'node:crypto';

import { ensureMainAgent, getLiveSessionById, interactions } from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface RespondWire {
  outcome: string;
  ended_at: string;
}

describe('server-v2 /api/v1/sessions/{sid}/interactions (approval)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-approvals-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
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

  async function createSession(): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    expect(body.code).toBe(0);
    const handle = getLiveSessionById(server!.core.accessor, body.data.id);
    expect(handle).toBeDefined();
    await ensureMainAgent(handle!);
    return body.data.id;
  }

  function enqueueApproval(sessionId: string, toolCallId: string): string {
    const handle = getLiveSessionById(server!.core.accessor, sessionId);
    expect(handle).toBeDefined();
    const parked = interactions.enqueue({
      id: `approval_${randomUUID()}`,
      kind: 'approval',
      payload: {
        toolCallId,
        toolName: 'Bash',
        action: 'run',
        display: { kind: 'command', command: 'echo hi' },
      },
      tags: { agentId: 'main', sessionId, toolCallId },
    });
    return parked.id;
  }

  function pendingApprovalIds(sessionId: string): string[] {
    return interactions
      .findAll({ kind: 'approval', resolved: false, tags: { sessionId } })
      .map((i) => i.id);
  }

  it('responds to a pending approval through the interactions route', async () => {
    const sid = await createSession();
    const aid = enqueueApproval(sid, 'tc-2');

    const { body } = await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/${aid}`, {
      kind: 'approval',
      decision: 'approved',
    });
    expect(body.code).toBe(0);
    expect(body.data.outcome).toBe('approved');
    expect(Number.isNaN(Date.parse(body.data.ended_at))).toBe(false);

    expect(pendingApprovalIds(sid)).toEqual([]);
  });

  it('returns 40902 on a duplicate resolve (recently-resolved window)', async () => {
    const sid = await createSession();
    const aid = enqueueApproval(sid, 'tc-3');
    await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/${aid}`, {
      kind: 'approval',
      decision: 'approved',
    });

    const dup = await postJson<null>(`/api/v1/sessions/${sid}/interactions/${aid}`, {
      kind: 'approval',
      decision: 'approved',
    });
    expect(dup.body.code).toBe(40902);
  });

  it('returns 40001 when the body kind does not match the interaction', async () => {
    const sid = await createSession();
    const aid = enqueueApproval(sid, 'tc-kind');
    const { body } = await postJson<null>(`/api/v1/sessions/${sid}/interactions/${aid}`, {
      kind: 'question',
      dismissed: true,
    });
    expect(body.code).toBe(40001);

    expect(pendingApprovalIds(sid)).toEqual([aid]);
  });

  it('returns 40404 for an unknown interaction id', async () => {
    const sid = await createSession();
    const { body } = await postJson<null>(`/api/v1/sessions/${sid}/interactions/nope`, {
      kind: 'approval',
      decision: 'rejected',
    });
    expect(body.code).toBe(40404);
  });

  it('mints distinct approval ids when the provider reuses a tool_call id', async () => {
    const sid = await createSession();
    const first = enqueueApproval(sid, 'Bash_0');
    const second = enqueueApproval(sid, 'Bash_0');
    expect(first).not.toBe(second);

    expect(pendingApprovalIds(sid).toSorted()).toEqual([first, second].toSorted());

    for (const aid of [first, second]) {
      const resolved = await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/${aid}`, {
        kind: 'approval',
        decision: 'approved',
      });
      expect(resolved.body.code).toBe(0);
    }
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/nope/interactions/nope', {
      kind: 'approval',
      decision: 'approved',
    });
    expect(body.code).toBe(40401);
  });

});
