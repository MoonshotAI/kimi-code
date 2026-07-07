import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  ISessionLifecycleService,
} from '@moonshot-ai/agent-core-v2';
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

interface PromptItemWire {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued';
  content: unknown;
  created_at: string;
}

const PROMPT_TOML = [
  'default_model = "stub"',
  '',
  '[providers.stub]',
  'type = "openai"',
  'base_url = "http://127.0.0.1:9999"',
  'api_key = "stub"',
  '',
  '[models.stub]',
  'provider = "stub"',
  'model = "stub"',
  'max_context_size = 1000',
  '',
].join('\n');

describe('server-v2 /api/v1 prompts', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-prompts-'));
    await writeFile(join(home, 'config.toml'), PROMPT_TOML, 'utf-8');
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    arg?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const headers = authHeaders(
      server as RunningServer,
      arg === undefined ? {} : { 'content-type': 'application/json' },
    );
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (arg !== undefined) {
      init.body = JSON.stringify(arg);
    }
    const res = await fetch(`${base}${path}`, init as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(cwd: string): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  // The main agent scope is not created automatically on session creation
  // (server-v2 gap G10); create it here so the prompt route resolves.
  async function createMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
  }

  it('submits a prompt and lists it as active', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toMatch(/^msg_/);
    expect(submitted.body.data.status).toBe('running');
    // prompt_id IS the user_message_id now (one identity for prompt + message).
    expect(submitted.body.data.user_message_id).toBe(submitted.body.data.prompt_id);

    const list = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/v1/sessions/${id}/prompts`,
    );
    expect(list.body.code).toBe(0);
    if (list.body.data.active !== null) {
      expect(list.body.data.active.prompt_id).toBe(submitted.body.data.prompt_id);
    }
    expect(Array.isArray(list.body.data.queued)).toBe(true);
  });

  it('returns 40402 when aborting a prompt that already settled', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
    });
    const promptId = submitted.body.data.prompt_id;

    const aborted = await call<{ aborted: boolean }>(
      'POST',
      `/api/v1/sessions/${id}/prompts/${promptId}:abort`,
    );
    expect(aborted.body.code).toBe(40402);
  });

  it('returns 40402 when aborting an unknown prompt', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>(
      'POST',
      `/api/v1/sessions/${id}/prompts/prompt_does_not_exist:abort`,
    );
    expect(body.code).toBe(40402);
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await call<null>('POST', '/api/v1/sessions/nope/prompts', {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(body.code).toBe(40401);
  });

  it('lists prompts for a persisted session with no live handle (cold resume)', async () => {
    const id = await createSession(home as string);
    // Drop the in-memory handle so the session only exists on disk / in the
    // index — the state a session is in after a server restart. The route must
    // cold-resume it rather than report 40401.
    await server!.core.accessor.get(ISessionLifecycleService).close(id);
    expect(server!.core.accessor.get(ISessionLifecycleService).get(id)).toBeUndefined();

    const list = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/v1/sessions/${id}/prompts`,
    );
    expect(list.body.code).toBe(0);
    expect(list.body.data.active).toBeNull();
    expect(list.body.data.queued).toEqual([]);
  });

  it('routes a submitted prompt to the agent named by agent_id (BTW side channel)', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    // Fork the main agent into a side-channel child the way `/btw` does.
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.fork('main');

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'side question' }],
      agent_id: child.id,
    });
    expect(submitted.body.code).toBe(0);

    // The user message is appended to the target agent's context before the turn
    // runs, so it persists even after the (model-less) turn settles — a durable
    // signal of which agent actually received the prompt.
    const contextHasUserText = (
      handle: { accessor: { get: typeof child.accessor.get } },
      text: string,
    ): boolean =>
      handle.accessor
        .get(IAgentContextMemoryService)
        .get()
        .some(
          (m) =>
            m.role === 'user' &&
            m.content.some((p) => p.type === 'text' && p.text === text),
        );

    // The side-channel child received the prompt.
    expect(contextHasUserText(child, 'side question')).toBe(true);

    // The main agent must NOT have received it — previously the route ignored
    // agent_id and always targeted main, so the reply landed in the main view.
    const main = lifecycle.getHandle('main');
    expect(main).toBeDefined();
    expect(contextHasUserText(main!, 'side question')).toBe(false);
  });

  it('returns 40401 when agent_id names an unknown agent', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      agent_id: 'agent_does_not_exist',
    });
    expect(body.code).toBe(40401);
  });
});
