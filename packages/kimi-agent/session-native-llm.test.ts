// E2E: SessionClient in native-LLM mode against the real stdio engine and a
// local mock OpenAI (Chat Completions SSE) server.
//
// The engine talks to the "provider" directly — no llmStep on this side —
// and must stream `llm.delta` events (stamped with the session id) back
// over host/event while the turn runs to completion.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env['KIMI_AGENT_FORCE_STDIO'] = '1';

type RustLoop = typeof import('./rust-loop');
let rustLoop: RustLoop;
let server: Server;
let baseUrl: string;

/** SSE chunks for one streamed completion: "Hello" + " world", then stop. */
function sseBody(): string {
  const chunks = [
    { choices: [{ delta: { role: 'assistant', content: 'Hello' } }] },
    { choices: [{ delta: { content: ' world' } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

beforeAll(async () => {
  rustLoop = await import('./rust-loop');
  server = createServer((req, res) => {
    if (req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseBody());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
});

afterAll(() => {
  server.close();
});

describe('SessionClient native-LLM streaming (stdio e2e)', () => {
  it('streams provider deltas over host/event and completes the turn', async () => {
    const deltas: string[] = [];
    const sessionIds = new Set<string | null | undefined>();

    const client = await rustLoop.createSessionClient({
      sessionId: 'ts-native-s1',
      systemPrompt: 'test',
      model: 'mock-model',
      goalEnabled: false,
      nativeLlm: {
        protocol: 'openai',
        base_url: baseUrl,
        api_key: 'test-key',
        model: 'mock-model',
      },
      onEvent: (event) => {
        const e = event as {
          type?: string;
          part?: { type?: string; text?: string };
          session_id?: string | null;
        };
        if (e.type === 'llm.delta' && e.part?.type === 'text' && e.part.text !== undefined) {
          deltas.push(e.part.text);
          sessionIds.add(e.session_id);
        }
      },
    });
    expect(client, 'stdio engine must be available (build kimi-agent-cli first)').not.toBeNull();

    const result = await client!.prompt('say hello');
    expect(result).not.toBeNull();
    expect(result!.stop_reason).toBe('EndTurn');

    // The provider's stream reached this side token by token, routed to the
    // owning session.
    expect(deltas.join('')).toBe('Hello world');
    expect([...sessionIds]).toEqual(['ts-native-s1']);
  }, 30000);
});
