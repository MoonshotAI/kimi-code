import * as node_http from 'node:http';
import type { AddressInfo } from 'node:net';

import { APITimeoutError } from '#/errors';
import { generate } from '#/generate';
import type { Message } from '#/message';
import { KimiChatProvider } from '#/providers/kimi';
import { describe, expect, it } from 'vitest';

/**
 * End-to-end stall coverage: a real `KimiChatProvider` (OpenAI SDK over HTTP)
 * against a local server that sends response headers and one SSE chunk, then
 * holds the socket open forever — the exact mid-stream stall that used to
 * wedge sessions. `generate()` must fail with `APITimeoutError` once the
 * inactivity budget elapses instead of hanging.
 */

const USER_MSG: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
  toolCalls: [],
};

const FIRST_CHUNK = {
  id: 'chatcmpl-stall',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'test',
  choices: [{ index: 0, delta: { role: 'assistant', content: 'STALLED: ' } }],
};

interface HangingServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function createHangingServer(): Promise<HangingServer> {
  const server = node_http.createServer((req, res) => {
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(`data: ${JSON.stringify(FIRST_CHUNK)}\n\n`);
    // Never write again, never end — a dead mid-stream connection.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('generate() stream stall (live HTTP)', () => {
  it('times out a stalled chat-completions stream instead of hanging', async () => {
    const server = await createHangingServer();
    try {
      const provider = new KimiChatProvider({
        model: 'test',
        apiKey: 'test-key',
        baseUrl: server.baseUrl,
        stream: true,
      });
      const startedAt = Date.now();

      await expect(
        generate(provider, '', [], [USER_MSG], undefined, { streamStallTimeoutMs: 100 }),
      ).rejects.toBeInstanceOf(APITimeoutError);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      await server.close();
    }
  }, 15_000);
});
