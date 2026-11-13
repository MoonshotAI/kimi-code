import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer, type RunningServer } from '@moonshot-ai/kap-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LLMock, type ChatCompletionRequest, type ChatMessage } from '@copilotkit/aimock';

import { PrefixCache, type PrefixUsage } from '../helpers/prefixCache.js';

const PROMPT_ONE = 'cache probe one';
const PROMPT_TWO = 'cache probe two';

function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).map((part) => part.text ?? '').join('');
}

function stableMessages(request: ChatCompletionRequest): ChatMessage[] {
  return request.messages.filter((message) => !messageText(message).startsWith('<system-reminder>'));
}

function actualPrompt(request: ChatCompletionRequest): string {
  const last = stableMessages(request).findLast((message) => message.role === 'user');
  return last === undefined ? '' : messageText(last);
}

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
}

interface Snapshot {
  readonly session: {
    readonly busy: boolean;
    readonly last_turn_reason?: string;
    readonly usage: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cache_read_tokens: number;
      readonly cache_creation_tokens: number;
    };
  };
  readonly messages: {
    readonly items: Array<{
      readonly role: string;
      readonly content: Array<{ readonly type: string; readonly text?: string }>;
    }>;
  };
}

interface KapClient {
  createSession(cwd: string): Promise<string>;
  prompt(sessionId: string, text: string): Promise<string>;
  snapshot(sessionId: string): Promise<Snapshot>;
}

function createClient(base: string, token: string): KapClient {
  async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const envelope = (await response.json()) as Envelope<T>;
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`${method} ${path} failed: ${JSON.stringify(envelope)}`);
    }
    return envelope.data;
  }

  return {
    async createSession(cwd) {
      const data = await request<{ id: string }>('/api/v1/sessions', 'POST', {
        title: 'cache e2e',
        metadata: { cwd },
      });
      return data.id;
    },
    async prompt(sessionId, text) {
      const data = await request<{ prompt_id: string }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,
        'POST',
        {
          content: [{ type: 'text', text }],
          model: 'stub',
          permission_mode: 'yolo',
        },
      );
      return data.prompt_id;
    },
    snapshot(sessionId) {
      return request<Snapshot>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`, 'GET');
    },
  };
}

function assistantText(snapshot: Snapshot): string {
  return snapshot.messages.items
    .filter((item) => item.role === 'assistant')
    .flatMap((item) => item.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for kap');
}

describe('kap prompt cache e2e', () => {
  let home: string | undefined;
  let kap: RunningServer | undefined;
  let mock: LLMock | undefined;
  let base: string;
  let token: string;
  const usages: Array<PrefixUsage & { output: number }> = [];
  const requests: ChatCompletionRequest[] = [];

  beforeAll(async () => {
    mock = new LLMock({ port: 0, strict: true, logLevel: 'silent' });
    const cache = new PrefixCache();
    mock.on(
      { predicate: (request) => [PROMPT_ONE, PROMPT_TWO].includes(actualPrompt(request)) },
      (request) => {
        const usage = { ...cache.usageFor(request), output: 5 };
        usages.push(usage);
        requests.push(request);
        return {
          content: `mock reply ${usages.length}`,
          usage: {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
            prompt_tokens_details: { cached_tokens: usage.cachedInput },
          },
        };
      },
    );
    await mock.start();

    home = await mkdtemp(join(tmpdir(), 'kimi-e2e-cache-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        `base_url = "${mock.url}/api/v1"`,
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 100000',
        '',
      ].join('\n'),
      'utf-8',
    );
    kap = await startServer({
      hostIdentity: { productName: 'e2e-host', version: '0.0.0', platform: 'test' },
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      env: {
        ...process.env,
        KIMI_CODE_SEARCH_WORKER: 'false',
        KIMI_CODE_PERSISTENCE_MINIDB_READMODEL: 'false',
      },
    });
    base = `http://127.0.0.1:${kap.port}`;
    token = kap.authTokenService.getToken();
  });

  afterAll(async () => {
    await kap?.close();
    await mock?.stop();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it('returns cache usage through snapshot and preserves the cache prefix', { timeout: 60_000, tags: ['L0'] }, async () => {
    const client = createClient(base, token);
    const sessionId = await client.createSession(home!);

    await client.prompt(sessionId, PROMPT_ONE);
    await waitFor(async () => {
      const snapshot = await client.snapshot(sessionId);
      return !snapshot.session.busy && assistantText(snapshot).includes('mock reply 1');
    });
    await client.prompt(sessionId, PROMPT_TWO);
    await waitFor(async () => {
      const snapshot = await client.snapshot(sessionId);
      return !snapshot.session.busy && assistantText(snapshot).includes('mock reply 2');
    });

    const snapshot = await client.snapshot(sessionId);
    expect(snapshot.session.last_turn_reason).toBe('completed');
    expect(assistantText(snapshot)).toContain('mock reply 1');
    expect(assistantText(snapshot)).toContain('mock reply 2');

    expect(mock!.getRequests()).toHaveLength(2);
    expect(requests).toHaveLength(2);
    const [firstRequest, secondRequest] = [requests[0]!, requests[1]!];
    expect(requests.map((request) => actualPrompt(request))).toEqual([PROMPT_ONE, PROMPT_TWO]);
    expect(typeof firstRequest['prompt_cache_key']).toBe('string');
    expect(secondRequest['prompt_cache_key']).toBe(firstRequest['prompt_cache_key']);
    expect(secondRequest.tools).toEqual(firstRequest.tools);
    expect(secondRequest.messages.slice(0, firstRequest.messages.length)).toEqual(firstRequest.messages);

    expect(usages).toHaveLength(2);
    const [first, second] = [usages[0]!, usages[1]!];
    expect(first.cachedInput).toBe(0);
    expect(second.cachedInput).toBe(first.input);
    expect(snapshot.session.usage).toMatchObject({
      input_tokens: first.input - first.cachedInput + second.input - second.cachedInput,
      output_tokens: 10,
      cache_read_tokens: second.cachedInput,
      cache_creation_tokens: 0,
    });
  });
});
