/**
 * Engine-mode `/api/v1/sessions/{sid}/prompts`.
 *
 * In engine-only mode the prompt route is a thin projection onto the Rust
 * engine's `session/prompt` RPC: the body is `{ prompt: string }` (a text
 * prompt; the engine owns turn/context/media/profile semantics — the v2
 * media-compression / attachment-materialisation / profile-bind /
 * disabled-tools behaviour those prompts used to exercise in server-v2 was
 * retired with the engine migration, and its unit coverage lives in
 * packages/kimi-agent).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LlmChatRequest, LlmChatResponse } from '@moonshot-ai/kimi-agent/rust-loop';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

/** Deterministic host-proxy LLM stub: echoes a fixed completion so engine
 *  turns terminate instead of hanging waiting for a provider. */
async function stubLlm(_req: LlmChatRequest): Promise<LlmChatResponse> {
  return {
    content: 'stub completion',
    tool_calls: [],
    finish_reason: 'stop',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

describe('engine-mode /api/v1/sessions/{sid}/prompts', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-engine-prompts-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      llmStep: stubLlm,
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

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  it('submits a text prompt and returns the engine result', async () => {
    const id = await createSession();

    const submitted = await call<{ stop_reason: string; steps: number }>(
      'POST',
      `/api/v1/sessions/${id}/prompts`,
      { prompt: 'hello' },
    );
    expect(submitted.body.code).toBe(0);
    expect(typeof submitted.body.data.stop_reason).toBe('string');
    expect(typeof submitted.body.data.steps).toBe('number');
  });

  it('rejects a missing prompt field with 40001', async () => {
    const id = await createSession();

    const { body } = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {});
    expect(body.code).toBe(40001);
  });

  it('rejects an empty prompt with 40001', async () => {
    const id = await createSession();

    const { body } = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, { prompt: '' });
    expect(body.code).toBe(40001);
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await call<null>('POST', '/api/v1/sessions/nope/prompts', {
      prompt: 'hello',
    });
    expect(body.code).toBe(40401);
  });
});
