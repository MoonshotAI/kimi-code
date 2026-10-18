import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  closeSessionById,
  getLiveSessionById,
  IEventBus,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { ensureMainAgent } from '../src/transport/mainAgent';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  data: T;
}

interface RatingViewWire {
  phase: 'closed' | 'open' | 'pending' | 'thanks';
  appearance_id?: string;
  survey?: string;
  response?: string;
  settle_in_ms?: number;
  close_in_ms?: number;
}

describe('server-v2 /api/v1/sessions/{session_id}/rating', () => {
  let server: RunningServer;
  let home: string;
  let base: string;
  const logLines: string[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rating-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      env: { ...process.env, KIMI_CODE_SESSION_RATING_PREVIEW: '1' },
      logger: pino(
        { level: 'info' },
        new Writable({
          write(chunk, _encoding, callback) {
            logLines.push(String(chunk));
            callback();
          },
        }),
      ),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function request<T>(path: string, body?: unknown): Promise<Envelope<T>> {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: authHeaders(server, { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await response.json()) as Envelope<T>;
  }

  async function finishUserTurn(): Promise<string> {
    const created = await request<{ id: string }>('/api/v1/sessions', { metadata: { cwd: home } });
    const id = created.data.id;
    const session = getLiveSessionById(server.core.accessor, id);
    if (session === undefined) throw new Error('expected a live session');
    const bus = (await ensureMainAgent(session)).accessor.get(IEventBus);
    bus.publish(new TurnStarted({ agentId: MAIN_AGENT_ID, turnId: 1, origin: { kind: 'user' } }));
    bus.publish(new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 1, reason: 'completed' }));
    return id;
  }

  function previewEvents(): [unknown, unknown, unknown][] {
    return logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['msg'] === 'session rating preview event')
      .map((entry) => [entry['event'], entry['event_type'], entry['response']]);
  }

  it('reports closed for a session that has no rating', async () => {
    await expect(request<RatingViewWire>('/api/v1/sessions/unknown-session/rating')).resolves.toEqual(
      expect.objectContaining({ code: 0, data: { phase: 'closed' } }),
    );
  });

  it('rejects a rating answer without an appearance id', async () => {
    const response = await request<null>('/api/v1/sessions/unknown-session/rating', {
      op: 'select',
      response: 'good',
    });

    expect(response.code).toBe(40001);
  });

  it('opens, answers, undoes, and abandons a preview rating as the session closes', async () => {
    const id = await finishUserTurn();
    const path = `/api/v1/sessions/${id}/rating`;
    await new Promise((resolve) => setTimeout(resolve, 2100));

    const opened = await request<RatingViewWire>(path, { op: 'evaluate' });
    expect(opened.data).toMatchObject({ phase: 'open', survey: 'session' });
    const appearanceId = opened.data.appearance_id;

    const pending = await request<RatingViewWire>(path, {
      op: 'select',
      appearance_id: appearanceId,
      response: 'good',
    });
    expect(pending.data).toMatchObject({ phase: 'pending', response: 'good' });
    expect(pending.data.settle_in_ms).toBeGreaterThan(2000);
    await expect(request<RatingViewWire>(path)).resolves.toMatchObject({
      data: { phase: 'pending', appearance_id: appearanceId },
    });

    const undone = await request<RatingViewWire>(path, { op: 'undo', appearance_id: appearanceId });
    expect(undone.data).toEqual({ phase: 'open', appearance_id: appearanceId, survey: 'session' });

    await closeSessionById(server.core.accessor, id);
    await expect(request<RatingViewWire>(path)).resolves.toMatchObject({ data: { phase: 'closed' } });
    expect(previewEvents()).toEqual([
      ['feedback_survey', 'appeared', undefined],
      ['feedback_survey', 'abandoned', undefined],
    ]);
  });
});
