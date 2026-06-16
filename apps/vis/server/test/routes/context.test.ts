import { describe, it, expect, afterEach } from 'vitest';
import { buildSessionFixture } from '../fixtures/build';
import { contextRoute } from '../../src/routes/context';

describe('context route', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('echoes the new projection fields (contextTokens, goal, swarm)', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;

    const app = contextRoute(home);
    const res = await app.request('/session_fixture/context?agent=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The route must pass these projection fields straight through (it used to
    // cherry-pick only messages/usage/config/permission/planMode).
    expect(body).toHaveProperty('contextTokens');
    expect(body).toHaveProperty('goal');
    expect(body).toHaveProperty('swarm');

    // The sample fixture's only step.end carries usage 10+5 → contextTokens=15,
    // and has no goal / swarm records.
    expect(body['contextTokens']).toBe(15);
    expect(body['goal']).toBeNull();
    expect(body['swarm']).toEqual({ active: false });
  });

  it('still echoes the existing fields', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;

    const app = contextRoute(home);
    const res = await app.request('/session_fixture/context?agent=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body['sessionId']).toBe('session_fixture');
    expect(body['agentId']).toBe('main');
    expect(body).toHaveProperty('messages');
    expect(body).toHaveProperty('usage');
    expect(body).toHaveProperty('config');
    expect(body).toHaveProperty('permission');
    expect(body).toHaveProperty('planMode');
  });

  it('returns 404 for missing session', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = contextRoute(home);
    const res = await app.request('/no-such-session/context?agent=main');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 400 for invalid agent id', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = contextRoute(home);
    const res = await app.request('/session_fixture/context?agent=../escape');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('?history=full returns the pre-compaction messages (full reconstructed history)', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-compaction');
    cleanup = c;
    const app = contextRoute(home);

    // Default (model view): the pre-compaction message is dropped, leaving
    // [summary, after-compaction].
    const modelRes = await app.request('/session_fixture/context?agent=main');
    expect(modelRes.status).toBe(200);
    const modelBody = (await modelRes.json()) as {
      messages: { source: string; message: { content: { type: string; text?: string }[] } }[];
    };
    expect(modelBody.messages.map((m) => m.source)).toEqual([
      'compaction_summary', 'append_message',
    ]);

    // Full history: the pre-compaction message is KEPT, then the summary marker,
    // then the post-compaction tail.
    const fullRes = await app.request('/session_fixture/context?agent=main&history=full');
    expect(fullRes.status).toBe(200);
    const fullBody = (await fullRes.json()) as {
      messages: { source: string; message: { content: { type: string; text?: string }[] } }[];
    };
    expect(fullBody.messages.map((m) => m.source)).toEqual([
      'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(fullBody.messages[0]!.message.content[0]).toMatchObject({ text: 'before compaction' });
    expect(fullBody.messages[2]!.message.content[0]).toMatchObject({ text: 'after compaction' });
  });
});
