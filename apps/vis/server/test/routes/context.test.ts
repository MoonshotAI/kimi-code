import { describe, it, expect, afterEach } from 'vitest';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCompactionContinuationText } from '@moonshot-ai/agent-core-v2/agent/contextMemory/compactionHandoff';
import { buildSessionFixture } from '../fixtures/build';
import { contextRoute } from '../../src/routes/context';
import { wireRoute } from '../../src/routes/wire';

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
    const hashes = ['a', 'b', 'c'].map((char) => char.repeat(64));
    const prompt = {
      type: 'turn.prompt',
      input: [
        { type: 'image_url', imageUrl: { url: 'https://example.com/remote.png' } },
        { type: 'audio_url', audioUrl: { url: 'data:audio/mpeg;base64,AAA' } },
        { type: 'video_url', videoUrl: { url: `blobref:video/mp4;${hashes[0]}` } },
        { type: 'image_url', imageUrl: { url: `blobref:image/png;${hashes[1]}` } },
        { type: 'audio_url', audioUrl: { url: `blobref:audio/mpeg;${hashes[2]}` } },
        { type: 'video_url', videoUrl: { url: 'https://example.com/remote.mp4' } },
      ],
      origin: { kind: 'user' },
      time: 100,
    };
    await appendFile(
      join(home, 'sessions', 'wd_test_000000000000', 'session_fixture', 'agents', 'main', 'wire.jsonl'),
      `${JSON.stringify(prompt)}\n`,
    );

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

    const wireRes = await wireRoute(home).request('/session_fixture/wire?agent=main');
    expect(wireRes.status).toBe(200);
    const wireBody = (await wireRes.json()) as {
      records: {
        data: {
          type: string;
          input?: {
            type: string;
            imageUrl?: { url: string };
            audioUrl?: { url: string };
            videoUrl?: { url: string };
          }[];
        };
        raw: unknown;
      }[];
    };
    const entry = wireBody.records.find(
      (record) => record.data.type === 'turn.prompt' && record.data.input?.length === 6,
    )!;
    const urls = entry.data.input!.map(
      (part) => part.imageUrl?.url ?? part.audioUrl?.url ?? part.videoUrl?.url,
    );
    expect(urls).toEqual([
      'https://example.com/remote.png',
      'data:audio/mpeg;base64,AAA',
      `http://localhost/api/sessions/session_fixture/blobs/${hashes[0]}?agent=main&mime=video%2Fmp4`,
      `http://localhost/api/sessions/session_fixture/blobs/${hashes[1]}?agent=main&mime=image%2Fpng`,
      `http://localhost/api/sessions/session_fixture/blobs/${hashes[2]}?agent=main&mime=audio%2Fmpeg`,
      'https://example.com/remote.mp4',
    ]);
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

    // Default (model view): the real user prompt before compaction is KEPT, the
    // assistant reply is dropped, then the summary, then the post-compaction tail.
    const modelRes = await app.request('/session_fixture/context?agent=main');
    expect(modelRes.status).toBe(200);
    const modelBody = (await modelRes.json()) as {
      messages: { source: string; message: { content: { type: string; text?: string }[] } }[];
    };
    expect(modelBody.messages.map((m) => m.source)).toEqual([
      'append_message', 'compaction_summary', 'append_message', 'append_message',
    ]);
    expect(modelBody.messages[0]!.message.content[0]).toMatchObject({ text: 'before compaction' });
    expect(modelBody.messages[2]!.message.content[0]).toMatchObject({ text: buildCompactionContinuationText() });
    expect(modelBody.messages[3]!.message.content[0]).toMatchObject({ text: 'after compaction' });

    // Full history: every pre-compaction message (user prompt + assistant reply)
    // is KEPT, then the summary marker, then the post-compaction tail.
    const fullRes = await app.request('/session_fixture/context?agent=main&history=full');
    expect(fullRes.status).toBe(200);
    const fullBody = (await fullRes.json()) as {
      messages: { source: string; message: { content: { type: string; text?: string }[] } }[];
    };
    expect(fullBody.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(fullBody.messages[0]!.message.content[0]).toMatchObject({ text: 'before compaction' });
    expect(fullBody.messages[1]!.message.content[0]).toMatchObject({ text: 'assistant reply' });
    expect(fullBody.messages[3]!.message.content[0]).toMatchObject({ text: 'after compaction' });
  });
});
