import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import {
  globalAgentsMdResponseSchema,
  type GlobalAgentsMdResponse,
} from '../src/protocol/rest-global-agents-md';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 /api/v1/global-agents-md', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-global-agents-md-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (home !== undefined) await rm(join(home, 'AGENTS.md'), { force: true });
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  it('GET returns an empty snapshot when the file does not exist', async () => {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/global-agents-md');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<GlobalAgentsMdResponse>;
    expect(body.code).toBe(0);
    expect(globalAgentsMdResponseSchema.parse(body.data)).toEqual({
      path: join(home as string, 'AGENTS.md'),
      content: '',
      exists: false,
    });
  });

  it('PUT writes exact content and GET reads it back', async () => {
    const content = '# Global instructions\n\n保持原有空白  \n\t最后一行\n';
    const res = await authedFetch(server as RunningServer, base, '/api/v1/global-agents-md', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<GlobalAgentsMdResponse>;
    expect(body.code).toBe(0);
    expect(globalAgentsMdResponseSchema.parse(body.data)).toEqual({
      path: join(home as string, 'AGENTS.md'),
      content,
      exists: true,
    });
    await expect(readFile(join(home as string, 'AGENTS.md'), 'utf8')).resolves.toBe(content);

    const getRes = await authedFetch(server as RunningServer, base, '/api/v1/global-agents-md');
    const getBody = (await getRes.json()) as Envelope<GlobalAgentsMdResponse>;
    expect(getBody.code).toBe(0);
    expect(getBody.data).toEqual(body.data);
  });

  it('PUT rejects a missing content field', async () => {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/global-agents-md', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});
