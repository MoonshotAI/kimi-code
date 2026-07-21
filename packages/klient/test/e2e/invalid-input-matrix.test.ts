/**
 * Invalid-input × provider behavior matrix, pinned end-to-end through the
 * klient in-memory transport and a local mock model endpoint.
 *
 * Every case runs the REAL pipeline: klient facade → engine session/loop →
 * llmRequester → ModelRequesterImpl → composed ChatProvider.generate → the
 * provider's message-conversion layer → HTTP against a local `node:http`
 * server. The mock server captures request bodies (so fallbacks can be
 * asserted on their wire shape) and replies with scripted SSE streams or
 * HTTP errors. No real network is touched.
 *
 * Error layers are labeled in each case (and in the report):
 *  - l1: klient-side zod contract rejection (`KlientValidationError`,
 *    promise rejection from the facade call — never reaches the engine).
 *  - l2: engine-native error (provider conversion layer or engine services —
 *    surfaces as a failed turn whose error payload carries a v2 `Error2`
 *    domain code such as `provider.api_error`).
 *  - l3: scripted provider (mock server) error — an HTTP status error that
 *    enters through the provider SDK's error path, gets normalized into the
 *    `API*Error` family, and is translated by `translateProviderError`.
 *
 * Provider columns: plain OpenAI (protocol `openai`, no vendor), composed
 * Kimi (protocol `openai` + provider `type: kimi` — the trait-composition
 * path), Anthropic, and Google GenAI. Rows are chosen for representativeness
 * rather than a full cartesian product.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';

import type { Klient } from '../../src/index.js';
import type { AgentHandle } from '../../src/core/klient.js';
import type { KlientEvents } from '../../src/core/events/hub.js';
import { KlientValidationError } from '../../src/core/validation.js';
import { createKlient as createMemoryKlient } from '../../src/transports/memory/index.js';

// The dual/http e2e suites (and their `helpers/dual.ts`) were dropped with the
// http transport; the two wait primitives they exported are re-declared here.
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Resolve with the first payload of `name` (or reject on timeout). */
function onceEvent<TPayloadMap extends object, E extends keyof TPayloadMap & string>(
  events: KlientEvents<TPayloadMap>,
  name: E,
  timeoutMs = 60_000,
): Promise<TPayloadMap[E]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`timed out waiting for event ${name}`));
    }, timeoutMs);
    const sub = events.on(name, (payload) => {
      clearTimeout(timer);
      sub.dispose();
      resolve(payload);
    });
  });
}

// ---------------------------------------------------------------------------
// Model ids registered in the engine for this suite.
// ---------------------------------------------------------------------------

const M_OPENAI = 'matrix-openai';
const M_OPENAI_VISION = 'matrix-openai-vision';
const M_KIMI = 'matrix-kimi';
const M_ANTHROPIC = 'matrix-anthropic';
const M_GOOGLE = 'matrix-google';

const KIMI_PROVIDER = 'matrix-kimi-provider';

const IMAGE_BAD_MIME_URL = 'data:image/bmp;base64,QUJD'; // bmp is outside every base's allowlist
const IMAGE_BAD_BASE64_URL = 'data:image/png;base64,%%%not-base64%%%';
const VIDEO_HTTP_URL = 'https://example.com/clip.mp4';
const VIDEO_BAD_MIME_URL = 'data:video/x-ms-wmv;base64,QUJD';

/** 1x1 transparent PNG — real magic bytes so the engine's sniffer accepts it. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** Minimal ftyp box so the video sniffer reports video/mp4. */
const MP4_FTYP_HEX = '00000020667479706d703432000000006d70343269736f6d';

// ---------------------------------------------------------------------------
// Captured requests + scripted replies.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly contentType: string;
  /** Parsed JSON body when the content type is JSON, otherwise undefined. */
  readonly json: unknown;
  /** Raw body (kept for multipart inspection). */
  readonly raw: Buffer;
}

type MockReply =
  | { readonly kind: 'sse'; readonly lines: readonly string[] }
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'hang' };

type MockHandler = (request: CapturedRequest, callIndex: number) => MockReply;

const requests: CapturedRequest[] = [];
let handler: MockHandler = () => {
  throw new Error('mock handler not installed for this case');
};

function resetMock(next: MockHandler): void {
  requests.length = 0;
  handler = next;
}

/** A reply queue: each call shifts; once empty, `fallback` serves the rest. */
function queueScript(...replies: readonly (MockReply | undefined)[]): MockHandler {
  const queue = [...replies];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('mock script exhausted');
    return next;
  };
}

function jsonError(status: number, message: string): MockReply {
  return { kind: 'json', status, body: { error: { message } } };
}

const OK_OPENAI: MockReply = { kind: 'sse', lines: openAiSse('OK') };
const OK_ANTHROPIC: MockReply = { kind: 'sse', lines: anthropicSse('OK') };
const OK_GOOGLE: MockReply = { kind: 'sse', lines: googleSse('OK') };

// ---------------------------------------------------------------------------
// SSE fixtures per wire protocol.
// ---------------------------------------------------------------------------

function sseLines(...events: readonly string[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    lines.push(`data: ${event}`, '');
  }
  return lines;
}

function openAiSse(text: string): string[] {
  return [
    ...sseLines(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      }),
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    ),
    'data: [DONE]',
    '',
  ];
}

function openAiToolCallSse(id: string, name: string, args: string): string[] {
  return [
    ...sseLines(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                { index: 0, id, type: 'function', function: { name, arguments: args } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
    ),
    'data: [DONE]',
    '',
  ];
}

function anthropicSse(text: string): string[] {
  return [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'mock',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    })}`,
    '',
    'event: content_block_start',
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })}`,
    '',
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    })}`,
    '',
    'event: message_stop',
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
  ];
}

function googleSse(text: string): string[] {
  return sseLines(
    JSON.stringify({
      candidates: [
        { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      responseId: 'resp-mock',
    }),
  );
}

// ---------------------------------------------------------------------------
// Engine + klient + mock server lifecycle.
// ---------------------------------------------------------------------------

let klient: Klient;
let app: ReturnType<typeof bootstrap>['app'] | undefined;
let server: Server;
let baseUrl: string;
let homeDir: string;
let workRoot: string;
const sockets = new Set<import('node:net').Socket>();

beforeAll(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'klient-matrix-home-'));
  workRoot = await mkdtemp(join(tmpdir(), 'klient-matrix-work-'));
  ({ app } = bootstrap({ homeDir }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]));
  klient = createMemoryKlient({ scope: app });

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      const contentType = String(req.headers['content-type'] ?? '');
      let json: unknown;
      if (contentType.includes('json')) {
        try {
          json = JSON.parse(raw.toString('utf8'));
        } catch {
          json = undefined;
        }
      }
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        contentType,
        json,
        raw,
      };
      requests.push(captured);
      let reply: MockReply;
      try {
        reply = handler(captured, requests.length - 1);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock handler: ${String(error)}` } }));
        return;
      }
      if (reply.kind === 'hang') return; // never answered; the client aborts it
      if (reply.kind === 'json') {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Trailing '\n' closes the final event — some SDK SSE parsers (Google
      // GenAI) only dispatch an event on a blank-line terminator.
      res.end(`${reply.lines.join('\n')}\n`);
    })().catch(() => {
      res.destroy();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await klient.global.providers.set({
    name: KIMI_PROVIDER,
    config: { type: 'kimi', apiKey: 'test-key', baseUrl: `${baseUrl}/v1` },
  });
  await klient.global.models.set({
    id: M_OPENAI,
    config: {
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      baseUrl: `${baseUrl}/v1`,
      protocol: 'openai',
      maxContextSize: 262_144,
    },
  });
  await klient.global.models.set({
    id: M_OPENAI_VISION,
    config: {
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      baseUrl: `${baseUrl}/v1`,
      protocol: 'openai',
      maxContextSize: 262_144,
      capabilities: ['image_in', 'video_in'],
    },
  });
  await klient.global.models.set({
    id: M_KIMI,
    config: {
      model: 'kimi-k2-matrix',
      provider: KIMI_PROVIDER,
      protocol: 'openai',
      maxContextSize: 262_144,
      capabilities: ['image_in', 'video_in'],
    },
  });
  await klient.global.models.set({
    id: M_ANTHROPIC,
    config: {
      model: 'claude-sonnet-4-5',
      apiKey: 'test-key',
      baseUrl: `${baseUrl}/v1`,
      protocol: 'anthropic',
      maxContextSize: 262_144,
    },
  });
  await klient.global.models.set({
    id: M_GOOGLE,
    config: {
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      baseUrl,
      protocol: 'google-genai',
      maxContextSize: 262_144,
    },
  });
}, 60_000);

afterAll(async () => {
  await klient.close();
  app?.dispose();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  await rm(workRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

// ---------------------------------------------------------------------------
// Case helpers.
// ---------------------------------------------------------------------------

interface CollectedEvent {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

interface CaseContext {
  readonly agent: AgentHandle;
  readonly events: CollectedEvent[];
  readonly workDir: string;
  eventNames(): readonly string[];
  payloads(name: string): Record<string, unknown>[];
}

async function newCase(modelId: string, label: string): Promise<CaseContext> {
  const workDir = join(workRoot, label);
  await mkdir(workDir, { recursive: true });
  const session = await klient.global.sessions.create({ workDir });
  const agent = klient.session(session.id).agent('main');
  await agent.setModel(modelId);

  const events: CollectedEvent[] = [];
  const record =
    (name: string) =>
    (payload: Record<string, unknown>): void => {
      events.push({ name, payload });
    };
  agent.events.on('turn.started', record('turn.started'));
  agent.events.on('turn.ended', record('turn.ended'));
  agent.events.on('error', record('error'));
  agent.events.on('prompt.completed', record('prompt.completed'));
  agent.events.on('prompt.aborted', record('prompt.aborted'));

  return {
    agent,
    events,
    workDir,
    eventNames: () => events.map((event) => event.name),
    payloads: (name) => events.filter((event) => event.name === name).map((event) => event.payload),
  };
}

async function promptAndWait(ctx: CaseContext, input: readonly ContentPart[]): Promise<void> {
  const settled = Promise.race([
    onceEvent(ctx.agent.events, 'prompt.completed', 60_000),
    onceEvent(ctx.agent.events, 'prompt.aborted', 60_000),
  ]);
  await ctx.agent.prompt({ input });
  await settled;
}

/** Chat-completions messages array of the n-th captured request. */
function openAiMessages(callIndex: number): Record<string, unknown>[] {
  const body = requests[callIndex]?.json as { messages?: Record<string, unknown>[] } | undefined;
  expect(body?.messages, `request #${callIndex} should carry a messages array`).toBeDefined();
  return body!.messages!;
}

// ---------------------------------------------------------------------------
// l1 — klient contract validation (never reaches the engine).
// ---------------------------------------------------------------------------

describe('l1: klient input validation', () => {
  it('rejects an image_url part missing `url` before any engine work (l1)', async () => {
    const ctx = await newCase(M_OPENAI, 'l1-image-missing-url');
    resetMock(queueScript(OK_OPENAI));

    const badInput = [
      { type: 'image_url', imageUrl: {} },
    ] as unknown as readonly ContentPart[];
    const failure = await ctx.agent.prompt({ input: badInput }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KlientValidationError);
    expect((failure as KlientValidationError).phase).toBe('input');

    expect(requests).toHaveLength(0); // nothing reached the wire
    expect(ctx.events).toHaveLength(0); // no engine events at all
  }, 30_000);

  it('rejects an audio_url prompt part (not in the PromptPart union) (l1)', async () => {
    const ctx = await newCase(M_OPENAI, 'l1-audio-part');
    resetMock(queueScript(OK_OPENAI));

    const badInput = [
      { type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3' } },
    ] as unknown as readonly ContentPart[];
    const failure = await ctx.agent.prompt({ input: badInput }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KlientValidationError);
    expect((failure as KlientValidationError).phase).toBe('input');
    expect(requests).toHaveLength(0);
  }, 30_000);

  it('accepts an empty input array; the empty user message is dropped by the engine (l2 toleration)', async () => {
    const ctx = await newCase(M_OPENAI, 'l2-empty-input');
    resetMock(queueScript(OK_OPENAI));

    await promptAndWait(ctx, []);

    // klient's zod schema allows an empty array; the engine's prompt service
    // only appends non-empty user messages, so the request leaves with the
    // system prompt alone. The turn still completes.
    expect(requests).toHaveLength(1);
    const messages = openAiMessages(0);
    expect(messages.every((message) => message['role'] === 'system')).toBe(true);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Image blocks: illegal mime type / corrupt payload × providers.
// ---------------------------------------------------------------------------

describe('image blocks with invalid data', () => {
  it('a data-URL image with an unaccepted mime is replaced at prompt ingestion on EVERY provider (l2)', async () => {
    // PromptStepRequest gates image parts through gateImageFormatParts before
    // the turn starts: image/bmp never reaches any provider's conversion
    // layer — it becomes a text notice, the request goes out without the
    // image, and the turn completes. This is the engine's "session
    // poisoning" defense and is provider-independent.
    const cases = [
      { label: 'bmp-openai', model: M_OPENAI, reply: OK_OPENAI },
      { label: 'bmp-kimi', model: M_KIMI, reply: OK_OPENAI },
      { label: 'bmp-anthropic', model: M_ANTHROPIC, reply: OK_ANTHROPIC },
      { label: 'bmp-google', model: M_GOOGLE, reply: OK_GOOGLE },
    ] as const;
    for (const { label, model, reply } of cases) {
      const ctx = await newCase(model, label);
      resetMock(queueScript(reply));
      await promptAndWait(ctx, [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', imageUrl: { url: IMAGE_BAD_MIME_URL } },
      ]);
      expect(requests, label).toHaveLength(1);
      const wireText = JSON.stringify(requests[0]?.json);
      expect(wireText, label).toContain('unsupported image format image/bmp');
      expect(wireText, label).not.toContain('image/bmp;base64');
      expect(ctx.payloads('prompt.completed')[0]?.['reason'], label).toBe('completed');
    }
  }, 60_000);

  it('a malformed data URL is replaced with a notice at prompt ingestion (l2)', async () => {
    const ctx = await newCase(M_OPENAI, 'malformed-data-url');
    resetMock(queueScript(OK_OPENAI));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: 'data:definitely-not-a-data-url' } },
    ]);

    expect(requests).toHaveLength(1);
    const wireText = JSON.stringify(requests[0]?.json);
    expect(wireText).toContain('is not a valid data URL');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('openai: corrupt base64 with an accepted mime passes conversion; a 400 triggers media-stripped resend (l3 + engine fallback)', async () => {
    const ctx = await newCase(M_OPENAI, 'openai-image-base64');
    resetMock(queueScript(jsonError(400, 'Invalid image data'), OK_OPENAI));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: IMAGE_BAD_BASE64_URL } },
    ]);

    expect(requests).toHaveLength(2);
    // Ingestion accepts the declared mime (png) without validating the
    // payload; the OpenAI base forwards the data URL verbatim.
    const firstContent = openAiMessages(0).at(-1)?.['content'] as unknown[];
    expect(firstContent).toContainEqual({
      type: 'image_url',
      image_url: { url: IMAGE_BAD_BASE64_URL },
    });
    // The 400 + "invalid image" body classifies as an image-format error, so
    // llmRequester resends with the media stripped to a placeholder — and the
    // turn succeeds.
    const secondContent = openAiMessages(1).at(-1)?.['content'] as unknown[];
    expect(secondContent.some((part) => (part as { type?: string }).type === 'image_url')).toBe(
      false,
    );
    expect(JSON.stringify(secondContent)).toContain('image omitted for provider compatibility');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('kimi (composed): same media-strip fallback as plain openai (l3 + engine fallback)', async () => {
    const ctx = await newCase(M_KIMI, 'kimi-image-base64');
    resetMock(queueScript(jsonError(400, 'Invalid image data'), OK_OPENAI));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: IMAGE_BAD_BASE64_URL } },
    ]);

    expect(requests).toHaveLength(2);
    const firstContent = openAiMessages(0).at(-1)?.['content'] as unknown[];
    expect(firstContent).toContainEqual({
      type: 'image_url',
      image_url: { url: IMAGE_BAD_BASE64_URL },
    });
    const secondContent = openAiMessages(1).at(-1)?.['content'] as unknown[];
    expect(secondContent.some((part) => (part as { type?: string }).type === 'image_url')).toBe(
      false,
    );
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('google-genai: corrupt base64 rides inlineData; a 400 triggers media-stripped resend (l3 + engine fallback)', async () => {
    const ctx = await newCase(M_GOOGLE, 'google-image-base64');
    resetMock(queueScript(jsonError(400, 'Invalid image data'), OK_GOOGLE));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: IMAGE_BAD_BASE64_URL } },
    ]);

    expect(requests).toHaveLength(2);
    // convertMediaUrl parses the mime out of the data URL and never
    // validates the payload — it lands in inlineData.
    const firstParts = (
      (requests[0]?.json as { contents?: { parts?: unknown[] }[] }).contents ?? []
    ).flatMap((content) => content.parts ?? []);
    expect(firstParts).toContainEqual({
      inlineData: { mimeType: 'image/png', data: '%%%not-base64%%%' },
    });
    const secondParts = (
      (requests[1]?.json as { contents?: { parts?: unknown[] }[] }).contents ?? []
    ).flatMap((content) => content.parts ?? []);
    expect(secondParts.some((part) => (part as { inlineData?: unknown }).inlineData)).toBe(false);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('anthropic: corrupt base64 with a legal mime passes conversion, then gets stripped after a 400', async () => {
    const ctx = await newCase(M_ANTHROPIC, 'anthropic-image-base64');
    resetMock(queueScript(jsonError(400, 'could not process the image'), OK_ANTHROPIC));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: IMAGE_BAD_BASE64_URL } },
    ]);

    expect(requests).toHaveLength(2);
    // The base validates the mime STRING only; payload bytes go out as-is.
    // (The last block of the last message also carries an injected
    // cache_control marker — compare on the fields that matter.)
    const firstBlocks = (
      (requests[0]?.json as { messages?: { content?: unknown[] }[] }).messages ?? []
    ).flatMap((message) => (Array.isArray(message.content) ? message.content : []));
    const imageBlock = firstBlocks.find(
      (block): block is { type: 'image'; source: Record<string, unknown> } =>
        (block as { type?: string }).type === 'image',
    );
    expect(imageBlock?.source).toMatchObject({
      type: 'base64',
      data: '%%%not-base64%%%',
      media_type: 'image/png',
    });
    const secondBlocks = (
      (requests[1]?.json as { messages?: { content?: unknown[] }[] }).messages ?? []
    ).flatMap((message) => (Array.isArray(message.content) ? message.content : []));
    expect(secondBlocks.some((block) => (block as { type?: string }).type === 'image')).toBe(false);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Video blocks: URL pass-through, upload capability, illegal video data.
// ---------------------------------------------------------------------------

describe('video blocks', () => {
  it('video_url with an http URL passes through verbatim on every provider', async () => {
    const cases: Array<{
      label: string;
      model: string;
      reply: MockReply;
      assertBody: (body: unknown) => void;
    }> = [
      {
        label: 'video-url-openai',
        model: M_OPENAI,
        reply: OK_OPENAI,
        assertBody: (body) => {
          const parts = (body as { messages: { content?: unknown }[] }).messages.flatMap(
            (message) => (Array.isArray(message.content) ? message.content : []),
          );
          expect(parts).toContainEqual({
            type: 'video_url',
            video_url: { url: VIDEO_HTTP_URL },
          });
        },
      },
      {
        label: 'video-url-kimi',
        model: M_KIMI,
        reply: OK_OPENAI,
        assertBody: (body) => {
          const parts = (body as { messages: { content?: unknown }[] }).messages.flatMap(
            (message) => (Array.isArray(message.content) ? message.content : []),
          );
          expect(parts).toContainEqual({
            type: 'video_url',
            video_url: { url: VIDEO_HTTP_URL },
          });
        },
      },
      {
        label: 'video-url-anthropic',
        model: M_ANTHROPIC,
        reply: OK_ANTHROPIC,
        assertBody: (body) => {
          const blocks = (body as { messages: { content?: unknown }[] }).messages.flatMap(
            (message) => (Array.isArray(message.content) ? message.content : []),
          );
          expect(blocks).toContainEqual({
            type: 'video',
            source: { type: 'url', url: VIDEO_HTTP_URL },
          });
        },
      },
      {
        label: 'video-url-google',
        model: M_GOOGLE,
        reply: OK_GOOGLE,
        assertBody: (body) => {
          const parts = (body as { contents: { parts?: unknown[] }[] }).contents.flatMap(
            (content) => content.parts ?? [],
          );
          expect(parts).toContainEqual({
            fileData: { fileUri: VIDEO_HTTP_URL, mimeType: 'video/mp4' },
          });
        },
      },
    ];

    for (const { label, model, reply, assertBody } of cases) {
      const ctx = await newCase(model, label);
      resetMock(queueScript(reply));
      await promptAndWait(ctx, [
        { type: 'text', text: 'describe this clip' },
        { type: 'video_url', videoUrl: { url: VIDEO_HTTP_URL } },
      ]);
      expect(requests, label).toHaveLength(1);
      assertBody(requests[0]?.json);
      expect(ctx.payloads('prompt.completed')[0]?.['reason'], label).toBe('completed');
    }
  }, 60_000);

  it('kimi (composed): ReadMediaFile on a video uploads via the files API (uploadVideo trait)', async () => {
    const ctx = await newCase(M_KIMI, 'kimi-video-upload');
    await writeFile(join(ctx.workDir, 'clip.mp4'), Buffer.from(MP4_FTYP_HEX, 'hex'));

    let chatCallCount = 0;
    resetMock((req) => {
      if (req.url === '/v1/files') {
        return {
          kind: 'json',
          status: 200,
          body: {
            id: 'file-mock-video',
            object: 'file',
            bytes: 32,
            created_at: 1,
            filename: 'clip.mp4',
            purpose: 'video',
          },
        };
      }
      chatCallCount += 1;
      return chatCallCount === 1
        ? {
            kind: 'sse',
            lines: openAiToolCallSse('call_video_1', 'ReadMediaFile', '{"path":"clip.mp4"}'),
          }
        : OK_OPENAI;
    });
    await promptAndWait(ctx, [{ type: 'text', text: 'watch clip.mp4' }]);

    // The KimiFiles client POSTs multipart form data to {baseUrl}/files.
    const fileUpload = requests.find((request) => request.url === '/v1/files');
    expect(fileUpload).toBeDefined();
    expect(fileUpload?.contentType).toContain('multipart/form-data');
    const formText = fileUpload!.raw.toString('latin1');
    expect(formText).toContain('name="purpose"');
    expect(formText).toContain('video');
    expect(formText).toContain('clip.mp4');

    // Second chat call: the tool result carries the ms:// file reference in
    // the tool message content (trait mode keeps media parts in place).
    const chatCalls = requests.filter((request) => request.url === '/v1/chat/completions');
    expect(chatCalls).toHaveLength(2);
    const secondBody = chatCalls[1]?.json as { messages: Record<string, unknown>[] };
    const toolMessage = secondBody.messages.find((message) => message['role'] === 'tool');
    expect(JSON.stringify(toolMessage)).toContain('ms://file-mock-video');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('openai: no uploadVideo capability — the tool result is an error text, no files call', async () => {
    const ctx = await newCase(M_OPENAI_VISION, 'openai-video-upload');
    await writeFile(join(ctx.workDir, 'clip.mp4'), Buffer.from(MP4_FTYP_HEX, 'hex'));

    resetMock(
      queueScript(
        { kind: 'sse', lines: openAiToolCallSse('call_video_1', 'ReadMediaFile', '{"path":"clip.mp4"}') },
        OK_OPENAI,
      ),
    );
    await promptAndWait(ctx, [{ type: 'text', text: 'watch clip.mp4' }]);

    expect(requests.find((request) => request.url === '/v1/files')).toBeUndefined();
    const chatCalls = requests.filter((request) => request.url === '/v1/chat/completions');
    expect(chatCalls).toHaveLength(2);
    const secondBody = chatCalls[1]?.json as { messages: Record<string, unknown>[] };
    const toolMessage = secondBody.messages.find((message) => message['role'] === 'tool');
    // ModelRequesterImpl.uploadVideo throws for providers without the hook;
    // ReadMediaFile converts that into an error tool result (engine fallback).
    expect(String(toolMessage?.['content'])).toContain('does not support video upload');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('anthropic: illegal base64 video mime throws in conversion; retryable, so stepRetry re-runs (l2)', async () => {
    // "Unsupported media type for base64 video" does NOT match the
    // image-format non-retryable patterns, so stepRetry claims it. Cap the
    // retries at 2 attempts (1 re-run, ~500ms backoff) for the suite's sake.
    await klient.global.config.set({ domain: 'loopControl', patch: { maxRetriesPerStep: 2 } });
    try {
      const ctx = await newCase(M_ANTHROPIC, 'anthropic-video-mime');
      resetMock(queueScript(OK_ANTHROPIC));

      await promptAndWait(ctx, [
        { type: 'text', text: 'watch this' },
        { type: 'video_url', videoUrl: { url: VIDEO_BAD_MIME_URL } },
      ]);

      // The conversion throws before any HTTP on every attempt — zero requests
      // even though stepRetry re-ran the step once (retry is invisible on the
      // klient event surface; only the final failure is).
      expect(requests).toHaveLength(0);
      const turnEnded = ctx.payloads('turn.ended');
      expect(turnEnded).toHaveLength(1);
      expect(turnEnded[0]?.['reason']).toBe('failed');
      const wireError = turnEnded[0]?.['error'] as Record<string, unknown> | undefined;
      expect(wireError?.['code']).toBe('provider.api_error');
      expect(wireError?.['name']).toBe('ChatProviderError');
      expect(String(wireError?.['message'])).toContain('Unsupported media type for base64 video');

      // The same v2-native payload is recorded on the klient error event, in
      // order: turn.started → turn.ended → error → prompt.completed.
      const errorEvents = ctx.payloads('error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]?.['code']).toBe('provider.api_error');
      expect(ctx.eventNames()).toEqual(['turn.started', 'turn.ended', 'error', 'prompt.completed']);
      expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('failed');
    } finally {
      await klient.global.config.set({ domain: 'loopControl', patch: { maxRetriesPerStep: 10 } });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Tool-call / tool-result structure × providers.
// ---------------------------------------------------------------------------

describe('tool exchange structure', () => {
  it('openai: an unknown tool call still gets a paired (error) result on the wire', async () => {
    const ctx = await newCase(M_OPENAI, 'openai-unknown-tool');
    resetMock(
      queueScript(
        {
          kind: 'sse',
          lines: openAiToolCallSse('call_unknown_1', 'definitely_not_a_real_tool', '{}'),
        },
        OK_OPENAI,
      ),
    );
    await promptAndWait(ctx, [{ type: 'text', text: 'use the tool' }]);

    expect(requests).toHaveLength(2);
    const messages = openAiMessages(1);
    const assistant = messages.find(
      (message) => message['role'] === 'assistant' && message['tool_calls'] !== undefined,
    );
    expect(
      (assistant?.['tool_calls'] as { id: string }[]).map((call) => call.id),
    ).toContain('call_unknown_1');
    const toolMessage = messages.find(
      (message) => message['role'] === 'tool' && message['tool_call_id'] === 'call_unknown_1',
    );
    expect(toolMessage).toBeDefined();
    // toolExecutor's fallback for a missing tool: an error result, so the
    // exchange stays paired (engine-level toleration).
    expect(String(toolMessage?.['content'])).toContain('definitely_not_a_real_tool');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('media tool result: plain openai extracts text + appends a media user message; kimi keeps parts in place', async () => {
    const runMediaToolResultCase = async (
      model: string,
      label: string,
    ): Promise<Record<string, unknown>[]> => {
      const ctx = await newCase(model, label);
      await writeFile(join(ctx.workDir, 'pixel.png'), Buffer.from(PNG_1X1_BASE64, 'base64'));
      resetMock(
        queueScript(
          {
            kind: 'sse',
            lines: openAiToolCallSse('call_media_1', 'ReadMediaFile', '{"path":"pixel.png"}'),
          },
          OK_OPENAI,
        ),
      );
      await promptAndWait(ctx, [{ type: 'text', text: 'look at pixel.png' }]);
      expect(ctx.payloads('prompt.completed')[0]?.['reason'], label).toBe('completed');
      return openAiMessages(1);
    };

    // Plain openai: the base's extract_text fallback flattens the tool result
    // to text, and the image re-attaches as a trailing user message.
    const openAiWire = await runMediaToolResultCase(M_OPENAI_VISION, 'media-result-openai');
    const openAiTool = openAiWire.find((message) => message['role'] === 'tool');
    expect(typeof openAiTool?.['content']).toBe('string');
    expect(String(openAiTool?.['content'])).toContain('<image path=');
    const trailing = openAiWire.at(-1);
    expect(trailing?.['role']).toBe('user');
    const trailingContent = trailing?.['content'] as { type: string; text?: string }[];
    expect(trailingContent[0]).toEqual({
      type: 'text',
      text: 'Attached media from tool result:',
    });
    expect(trailingContent.some((part) => part.type === 'image_url')).toBe(true);

    // Composed kimi: trait mode hands shaping to the trait — the image part
    // stays inside the tool message content; no extra user message appears.
    const kimiWire = await runMediaToolResultCase(M_KIMI, 'media-result-kimi');
    const kimiTool = kimiWire.find((message) => message['role'] === 'tool');
    const kimiContent = kimiTool?.['content'] as { type: string }[];
    expect(Array.isArray(kimiContent)).toBe(true);
    expect(kimiContent.some((part) => part.type === 'image_url')).toBe(true);
    expect(kimiWire.at(-1)?.['role']).toBe('tool');
  }, 60_000);

  it('tool call ids are sanitized (64-char, safe charset) consistently across call and result', async () => {
    const nastyId = `call/bad id#${'x'.repeat(80)}`;
    const runIdCase = async (model: string, label: string): Promise<Record<string, unknown>[]> => {
      const ctx = await newCase(model, label);
      resetMock(
        queueScript(
          {
            kind: 'sse',
            lines: openAiToolCallSse(nastyId, 'definitely_not_a_real_tool', '{}'),
          },
          OK_OPENAI,
        ),
      );
      await promptAndWait(ctx, [{ type: 'text', text: 'use the tool' }]);
      expect(ctx.payloads('prompt.completed')[0]?.['reason'], label).toBe('completed');
      return openAiMessages(1);
    };

    for (const [model, label] of [
      [M_OPENAI, 'tool-id-openai'],
      [M_KIMI, 'tool-id-kimi'],
    ] as const) {
      const messages = await runIdCase(model, label);
      const assistant = messages.find((message) => message['tool_calls'] !== undefined);
      const wireId = (assistant?.['tool_calls'] as { id: string }[])[0]?.id;
      expect(wireId, label).toBeDefined();
      expect(wireId!.length, label).toBeLessThanOrEqual(64);
      expect(wireId, label).toMatch(/^[a-zA-Z0-9_-]+$/);
      const toolMessage = messages.find((message) => message['role'] === 'tool');
      // Normalization rewrites call and result with the SAME mapping.
      expect(toolMessage?.['tool_call_id'], label).toBe(wireId);
    }
  }, 60_000);

  it('after an abort, consecutive user messages are merged into one on the wire (projector fallback)', async () => {
    const ctx = await newCase(M_OPENAI, 'abort-merge');
    resetMock((_req, callIndex) => (callIndex === 0 ? { kind: 'hang' } : OK_OPENAI));

    const firstSettled = onceEvent(ctx.agent.events, 'prompt.aborted', 30_000);
    await ctx.agent.prompt({ input: [{ type: 'text', text: 'first message' }] });
    await waitFor(() => requests.length === 1, 10_000);
    await ctx.agent.cancel();
    await firstSettled;

    await promptAndWait(ctx, [{ type: 'text', text: 'second message' }]);

    expect(requests).toHaveLength(2);
    const userMessages = openAiMessages(1).filter((message) => message['role'] === 'user');
    // The projector folds consecutive origin=user messages into one
    // (\n\n-joined) instead of sending two same-role messages in a row.
    expect(userMessages).toHaveLength(1);
    expect(String(userMessages[0]?.['content'])).toContain('first message');
    expect(String(userMessages[0]?.['content'])).toContain('second message');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Scripted provider (mock server) errors — the l3 layer.
// ---------------------------------------------------------------------------

describe('provider HTTP errors', () => {
  it('a non-recoverable 422 fails the turn with provider.api_error + statusCode on the wire (l3)', async () => {
    const ctx = await newCase(M_OPENAI, 'openai-422');
    resetMock(queueScript(jsonError(422, 'validation exploded on field messages')));

    await promptAndWait(ctx, [{ type: 'text', text: 'hello' }]);

    expect(requests).toHaveLength(1); // 422 is not retried, not reprojected
    const turnEnded = ctx.payloads('turn.ended');
    expect(turnEnded).toHaveLength(1);
    expect(turnEnded[0]?.['reason']).toBe('failed');
    const wireError = turnEnded[0]?.['error'] as Record<string, unknown> | undefined;
    expect(wireError?.['code']).toBe('provider.api_error');
    expect(wireError?.['name']).toBe('APIStatusError');
    expect((wireError?.['details'] as Record<string, unknown> | undefined)?.['statusCode']).toBe(
      422,
    );
    expect(wireError?.['retryable']).toBe(false);

    const errorEvents = ctx.payloads('error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.['code']).toBe('provider.api_error');
    expect(ctx.eventNames()).toEqual(['turn.started', 'turn.ended', 'error', 'prompt.completed']);
  }, 30_000);

  it('a 400 structure error is retried once with the strict projection, then succeeds (l3 + engine fallback)', async () => {
    const ctx = await newCase(M_OPENAI, 'openai-400-strict');
    resetMock(
      queueScript(jsonError(400, "tool_call_id 'call_x' not found"), OK_OPENAI),
    );

    await promptAndWait(ctx, [{ type: 'text', text: 'hello' }]);

    // llmRequester recognizes the adjacency rejection and resends with the
    // strict projection before the loop ever sees an error.
    expect(requests).toHaveLength(2);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
    expect(ctx.payloads('error')).toHaveLength(0);
  }, 30_000);
});
