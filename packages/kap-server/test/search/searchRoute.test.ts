import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionIndex, type SessionSummary } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../../src/start';
import { TEST_HOST_IDENTITY } from '../helpers/hostIdentity';
import { authedFetch } from '../helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface SearchPageWire {
  items: {
    session_id: string;
    workspace_id: string;
    session_title: string;
    agent_id: string;
    role: string;
    snippet: string;
    time: number;
    turn?: number;
    step_id?: string;
    score: number;
  }[];
  has_more: boolean;
  page_token?: string;
  incomplete?: string;
  index_state: {
    state: string;
    indexed_sessions: number;
    total_sessions: number;
    documents: number;
  };
  source: string;
}

const WS = 'ws_route';

function stubSessionIndex(summaries: SessionSummary[]): ISessionIndex {
  return {
    _serviceBrand: undefined,
    list: async () => ({ items: summaries, nextCursor: undefined }),
    get: async () => undefined,
    countActive: async () => summaries.length,
    remove: async () => {},
  };
}

describe('server-v2 /api/v1/search', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-search-'));
    // Fixture first: the boot-time background sync picks it up on its own.
    const sessionDir = join(home, 'sessions', WS, 's1', 'agents', 'main');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'wire.jsonl'),
      [
        JSON.stringify({
          type: 'context.append_message',
          time: 1_700_000_000_000,
          message: {
            role: 'user',
            content: [{ type: 'text', text: '帮我查一下苹果的价格' }],
            origin: { kind: 'user' },
          },
        }),
        JSON.stringify({
          type: 'context.append_loop_event',
          time: 1_700_000_000_100,
          event: { type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 },
        }),
        JSON.stringify({
          type: 'context.append_loop_event',
          time: 1_700_000_000_200,
          event: {
            type: 'content.part',
            stepUuid: 'u1',
            part: { type: 'text', text: '苹果现价每斤九块九。' },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    const summaries: SessionSummary[] = [
      {
        id: 's1',
        workspaceId: WS,
        title: '苹果询价',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        archived: false,
      },
    ];
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[ISessionIndex, stubSessionIndex(summaries)]],
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

  async function postSearch(body: unknown): Promise<Envelope<SearchPageWire>> {
    const res = await authedFetch(server!, base, '/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Envelope<SearchPageWire>;
  }

  it('searches across sessions and returns the wire-shaped page', { timeout: 20_000 }, async () => {
    // The first sync runs in the background at boot; poll until it lands.
    let body: Envelope<SearchPageWire> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      body = await postSearch({ query: '苹果' });
      expect(body.code).toBe(0);
      if (body.data.items.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(body).toBeDefined();
    expect(body!.data.items.length).toBeGreaterThan(0);

    // Both the user message and the session title match '苹果'.
    const hit = body!.data.items.find((h) => h.role === 'user');
    expect(hit).toBeDefined();
    expect(hit!.session_id).toBe('s1');
    expect(hit!.workspace_id).toBe(WS);
    expect(hit!.session_title).toBe('苹果询价');
    expect(hit!.agent_id).toBe('main');
    expect(hit!.snippet).toContain('苹果');
    expect(hit!.step_id).toBeUndefined();
    // The assistant hit carries its transcript step id.
    const assistant = body!.data.items.find((h) => h.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.turn).toBe(0);
    expect(assistant!.step_id).toBe('t0.1');
    expect(body!.data.items.some((h) => h.role === 'title')).toBe(true);
    expect(body!.data.has_more).toBe(false);
    expect(['building', 'ready', 'readonly']).toContain(body!.data.index_state.state);
    // No session is live in this server, so the page comes from the index.
    expect(body!.data.source).toBe('index');
  });

  it('rejects invalid bodies with 40001', async () => {
    const emptyQuery = await postSearch({ query: '' });
    expect(emptyQuery.code).toBe(40001);

    const oversizedPage = await postSearch({ query: '苹果', page_size: 51 });
    expect(oversizedPage.code).toBe(40001);

    const badSort = await postSearch({ query: '苹果', sort: 'newest' });
    expect(badSort.code).toBe(40001);

    const badMode = await postSearch({ query: '苹果', mode: 'exact' });
    expect(badMode.code).toBe(40001);

    // A 1-character literal query is rejected by the service, not the schema.
    const shortLiteral = await postSearch({ query: '苹', mode: 'literal' });
    expect(shortLiteral.code).toBe(40001);
    expect(shortLiteral.msg).toContain('at least 2 characters');

    // A page token that decodes to a non-object is a parameter error, not a 500.
    const nullToken = await postSearch({
      query: '苹果',
      page_token: Buffer.from('null').toString('base64url'),
    });
    expect(nullToken.code).toBe(40001);
  });

  it('serves literal mode through the wire', { timeout: 20_000 }, async () => {
    let body: Envelope<SearchPageWire> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      body = await postSearch({ query: '的价格', mode: 'literal' });
      expect(body.code).toBe(0);
      if (body.data.items.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(body).toBeDefined();
    const hit = body!.data.items.find((h) => h.role === 'user');
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain('的价格');
    expect(hit!.score).toBe(0);
    expect(body!.data.items.some((h) => h.role === 'assistant')).toBe(false);
    expect(body!.data.incomplete).toBeUndefined();
  });
});
