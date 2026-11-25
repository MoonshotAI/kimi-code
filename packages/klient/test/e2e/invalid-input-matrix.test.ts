import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import {
  call,
  httpError,
  say,
  startFakeModel,
  type FakeModel,
  type Lane,
  type ModelRequest,
} from '@moonshot-ai/testkit/model';

import { TEST_CLIENT_IDENTITY } from '../helpers/engine.js';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/message';
import { IModelService } from '@moonshot-ai/agent-core-v2/llm-adapter/model/model';

import type { Klient } from '../../src/index.js';
import type { AgentHandle } from '../../src/core/klient.js';
import type { KlientEvents } from '../../src/core/events/hub.js';
import { KlientValidationError } from '../../src/core/validation.js';
import { createKlient as createMemoryKlient } from '../../src/transports/memory/index.js';

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

type ProviderKind = 'openai' | 'openai-vision' | 'kimi' | 'anthropic' | 'google';

const IMAGE_BAD_MIME_URL = 'data:image/tiff;base64,QUJD';
const IMAGE_KIMI_ONLY_MIME_URL = 'data:image/bmp;base64,QUJD';
const IMAGE_BAD_BASE64_URL = 'data:image/png;base64,%%%not-base64%%%';
const VIDEO_HTTP_URL = 'https://example.com/clip.mp4';
const VIDEO_BAD_MIME_URL = 'data:video/x-ms-wmv;base64,QUJD';

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MP4_FTYP_HEX = '00000020667479706d703432000000006d70343269736f6d';

const API_AUTH = { method: 'api-key', apiKey: 'test-key' } as const;

let klient: Klient;
let app: ReturnType<typeof bootstrap>['app'] | undefined;
let homeDir: string;
let workRoot: string;
const openModels: FakeModel[] = [];

beforeAll(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'klient-matrix-home-'));
  workRoot = await mkdtemp(join(tmpdir(), 'klient-matrix-work-'));
  ({ app } = bootstrap({ homeDir, clientIdentity: TEST_CLIENT_IDENTITY }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]));
  klient = createMemoryKlient({ scope: app });
}, 60_000);

afterEach(async () => {
  const models = openModels.splice(0);
  try {
    for (const model of models) model.verify();
  } finally {
    await Promise.all(models.map((model) => model.close()));
  }
});

afterAll(async () => {
  await klient.close();
  app?.dispose();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  await rm(workRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

async function registerModel(kind: ProviderKind, id: string, origin: string): Promise<void> {
  const kosong = klient.global.kosong;
  switch (kind) {
    case 'kimi': {
      const provider = `${id}-provider`;
      await kosong.addProvider(provider, { type: 'kimi', auth: API_AUTH, baseUrl: `${origin}/v1` });
      await app!.accessor.get(IModelService).set(id, {
        model: 'kimi-k2-matrix',
        provider,
        protocol: 'openai',
        maxContextSize: 262_144,
        capabilities: ['image_in', 'video_in'],
      });
      return;
    }
    case 'openai':
    case 'openai-vision':
      await kosong.addProvider({
        id,
        model: 'gpt-4o-mini',
        protocol: 'openai',
        baseUrl: `${origin}/v1`,
        auth: API_AUTH,
        maxContextSize: 262_144,
        ...(kind === 'openai-vision' ? { capabilities: { image_in: true, video_in: true } } : {}),
      });
      return;
    case 'anthropic':
      await kosong.addProvider({
        id,
        model: 'claude-sonnet-4-5',
        protocol: 'anthropic',
        baseUrl: `${origin}/v1`,
        auth: API_AUTH,
        maxContextSize: 262_144,
      });
      return;
    case 'google':
      await kosong.addProvider({
        id,
        model: 'gemini-2.5-flash',
        protocol: 'google-genai',
        baseUrl: origin,
        auth: API_AUTH,
        maxContextSize: 262_144,
      });
      return;
  }
}

interface CollectedEvent {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

interface CaseContext {
  readonly agent: AgentHandle;
  readonly model: FakeModel;
  readonly lane: Lane;
  readonly events: CollectedEvent[];
  readonly workDir: string;
  eventNames(): readonly string[];
  payloads(name: string): Record<string, unknown>[];
  body(callIndex: number): unknown;
}

async function newCase(kind: ProviderKind, label: string): Promise<CaseContext> {
  const model = await startFakeModel();
  openModels.push(model);
  const modelId = `matrix-${label}`;
  await registerModel(kind, modelId, model.origin);
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
    model,
    lane: model.route(label, () => true),
    events,
    workDir,
    eventNames: () => events.map((event) => event.name),
    payloads: (name) => events.filter((event) => event.name === name).map((event) => event.payload),
    body: (callIndex) => requestAt(model, callIndex).body,
  };
}

function requestAt(model: FakeModel, callIndex: number): ModelRequest {
  const request = model.requests()[callIndex];
  expect(request, `request #${callIndex} should have reached the model`).toBeDefined();
  return request!;
}

async function promptAndWait(ctx: CaseContext, input: readonly ContentPart[]): Promise<void> {
  const settled = Promise.race([
    onceEvent(ctx.agent.events, 'prompt.completed', 60_000),
    onceEvent(ctx.agent.events, 'prompt.aborted', 60_000),
  ]);
  await ctx.agent.prompt({ input });
  await settled;
}

function openAiMessages(ctx: CaseContext, callIndex: number): Record<string, unknown>[] {
  const body = ctx.body(callIndex) as { messages?: Record<string, unknown>[] };
  expect(body.messages, `request #${callIndex} should carry a messages array`).toBeDefined();
  return body.messages!.filter((message) => !isDateReminderMessage(message));
}

const DATE_REMINDER_MARKERS = [
  'The current date is restated in a reminder whenever it changes',
  'Rely on this reminder over any earlier date statement',
];

function isDateReminderMessage(message: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(message);
  return DATE_REMINDER_MARKERS.some((marker) => serialized.includes(marker));
}

describe('l1: klient input validation', () => {
  it('rejects an image_url part missing `url` before any engine work (l1)', async () => {
    const ctx = await newCase('openai', 'l1-image-missing-url');

    const badInput = [
      { type: 'image_url', imageUrl: {} },
    ] as unknown as readonly ContentPart[];
    const failure = await ctx.agent.prompt({ input: badInput }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KlientValidationError);
    expect((failure as KlientValidationError).phase).toBe('input');

    expect(ctx.model.requests()).toHaveLength(0);
    expect(ctx.events).toHaveLength(0);
  }, 30_000);

  it('rejects an audio_url prompt part (not in the PromptPart union) (l1)', async () => {
    const ctx = await newCase('openai', 'l1-audio-part');

    const badInput = [
      { type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3' } },
    ] as unknown as readonly ContentPart[];
    const failure = await ctx.agent.prompt({ input: badInput }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KlientValidationError);
    expect((failure as KlientValidationError).phase).toBe('input');
    expect(ctx.model.requests()).toHaveLength(0);
  }, 30_000);

  it('accepts an empty input array; the empty user message is dropped by the engine (l2 toleration)', async () => {
    const ctx = await newCase('openai', 'l2-empty-input');
    ctx.lane.script(say('OK'));

    await promptAndWait(ctx, []);

    expect(ctx.model.requests()).toHaveLength(1);
    const messages = openAiMessages(ctx, 0);
    expect(messages.every((message) => message['role'] === 'system')).toBe(true);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);
});

describe('image blocks with invalid data', () => {
  it('a data-URL image with an unaccepted mime is replaced at prompt ingestion on EVERY provider (l2)', async () => {
    const cases = [
      { label: 'tiff-openai', kind: 'openai' },
      { label: 'tiff-kimi', kind: 'kimi' },
      { label: 'tiff-anthropic', kind: 'anthropic' },
      { label: 'tiff-google', kind: 'google' },
    ] as const;
    for (const { label, kind } of cases) {
      const ctx = await newCase(kind, label);
      ctx.lane.script(say('OK'));
      await promptAndWait(ctx, [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', imageUrl: { url: IMAGE_BAD_MIME_URL } },
      ]);
      expect(ctx.model.requests(), label).toHaveLength(1);
      const wireText = JSON.stringify(ctx.body(0));
      expect(wireText, label).toContain('unsupported image format image/tiff');
      expect(wireText, label).not.toContain('image/tiff;base64');
      expect(ctx.payloads('prompt.completed')[0]?.['reason'], label).toBe('completed');
    }
  }, 60_000);

  it('a data-URL image in a Kimi-only format reaches a Kimi model but is replaced elsewhere (l2)', async () => {
    const cases = [
      { label: 'bmp-kimi', kind: 'kimi', accepted: true },
      { label: 'bmp-openai', kind: 'openai', accepted: false },
      { label: 'bmp-anthropic', kind: 'anthropic', accepted: false },
    ] as const;
    for (const { label, kind, accepted } of cases) {
      const ctx = await newCase(kind, label);
      ctx.lane.script(say('OK'));
      await promptAndWait(ctx, [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', imageUrl: { url: IMAGE_KIMI_ONLY_MIME_URL } },
      ]);
      expect(ctx.model.requests(), label).toHaveLength(1);
      const wireText = JSON.stringify(ctx.body(0));
      expect(wireText.includes('image/bmp;base64'), label).toBe(accepted);
      expect(wireText.includes('unsupported image format image/bmp'), label).toBe(!accepted);
      expect(ctx.payloads('prompt.completed')[0]?.['reason'], label).toBe('completed');
    }
  }, 60_000);

  it('a malformed data URL is replaced with a notice at prompt ingestion (l2)', async () => {
    const ctx = await newCase('openai', 'malformed-data-url');
    ctx.lane.script(say('OK'));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: 'data:definitely-not-a-data-url' } },
    ]);

    expect(ctx.model.requests()).toHaveLength(1);
    const wireText = JSON.stringify(ctx.body(0));
    expect(wireText).toContain('is not a valid data URL');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('openai: corrupt base64 with an accepted mime passes conversion; a 400 triggers media-stripped resend (l3 + engine fallback)', async () => {
    const ctx = await newCase('openai', 'openai-image-base64');
    ctx.lane.script(httpError(400, { message: 'Invalid image data' }), say('OK'));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: IMAGE_BAD_BASE64_URL } },
    ]);

    expect(ctx.model.requests()).toHaveLength(2);
    const firstContent = openAiMessages(ctx, 0).at(-1)?.['content'] as unknown[];
    expect(firstContent).toContainEqual({
      type: 'image_url',
      image_url: { url: IMAGE_BAD_BASE64_URL },
    });
    const secondContent = openAiMessages(ctx, 1).at(-1)?.['content'] as unknown[];
    expect(secondContent.some((part) => (part as { type?: string }).type === 'image_url')).toBe(
      false,
    );
    expect(JSON.stringify(secondContent)).toContain('image omitted for provider compatibility');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('kimi (composed): same media-strip fallback as plain openai (l3 + engine fallback)', async () => {
    const ctx = await newCase('kimi', 'kimi-image-base64');
    ctx.lane.script(httpError(400, { message: 'Invalid image data' }), say('OK'));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: IMAGE_BAD_BASE64_URL } },
    ]);

    expect(ctx.model.requests()).toHaveLength(2);
    const firstContent = openAiMessages(ctx, 0).at(-1)?.['content'] as unknown[];
    expect(firstContent).toContainEqual({
      type: 'image_url',
      image_url: { url: IMAGE_BAD_BASE64_URL },
    });
    const secondContent = openAiMessages(ctx, 1).at(-1)?.['content'] as unknown[];
    expect(secondContent.some((part) => (part as { type?: string }).type === 'image_url')).toBe(
      false,
    );
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('google-genai: corrupt base64 rides inlineData; a 400 triggers media-stripped resend (l3 + engine fallback)', async () => {
    const ctx = await newCase('google', 'google-image-base64');
    ctx.lane.script(httpError(400, { message: 'Invalid image data' }), say('OK'));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: IMAGE_BAD_BASE64_URL } },
    ]);

    expect(ctx.model.requests()).toHaveLength(2);
    const firstParts = (
      (ctx.body(0) as { contents?: { parts?: unknown[] }[] }).contents ?? []
    ).flatMap((content) => content.parts ?? []);
    expect(firstParts).toContainEqual({
      inlineData: { mimeType: 'image/png', data: '%%%not-base64%%%' },
    });
    const secondParts = (
      (ctx.body(1) as { contents?: { parts?: unknown[] }[] }).contents ?? []
    ).flatMap((content) => content.parts ?? []);
    expect(secondParts.some((part) => (part as { inlineData?: unknown }).inlineData)).toBe(false);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('anthropic: corrupt base64 with a legal mime passes conversion, then gets stripped after a 400', async () => {
    const ctx = await newCase('anthropic', 'anthropic-image-base64');
    ctx.lane.script(httpError(400, { message: 'could not process the image' }), say('OK'));

    await promptAndWait(ctx, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', imageUrl: { url: IMAGE_BAD_BASE64_URL } },
    ]);

    expect(ctx.model.requests()).toHaveLength(2);
    const firstBlocks = (
      (ctx.body(0) as { messages?: { content?: unknown[] }[] }).messages ?? []
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
      (ctx.body(1) as { messages?: { content?: unknown[] }[] }).messages ?? []
    ).flatMap((message) => (Array.isArray(message.content) ? message.content : []));
    expect(secondBlocks.some((block) => (block as { type?: string }).type === 'image')).toBe(false);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);
});

describe('daemon file references (kimi-file://)', () => {
  it('a kimi-file image reference reaches a non-kimi provider as a data URL, never verbatim', async () => {
    const meta = await klient.global.files.save({
      data: new Uint8Array(Buffer.from(PNG_1X1_BASE64, 'base64')),
      filename: 'pasted-image.png',
      mimeType: 'image/png',
      expiresInSec: 3600,
    });
    const ctx = await newCase('openai-vision', 'kimifile-image-openai');
    ctx.lane.script(say('OK'));
    await promptAndWait(ctx, [
      { type: 'image_url', imageUrl: { url: `kimi-file://${meta.id}` } },
      { type: 'text', text: 'what is this?' },
    ]);
    expect(ctx.model.requests()).toHaveLength(1);
    expect(JSON.stringify(ctx.body(0))).not.toContain(`kimi-file://${meta.id}`);
    const content = openAiMessages(ctx, 0).at(-1)?.['content'] as unknown[];
    const imagePart = content.find(
      (part) => (part as { type?: string }).type === 'image_url',
    ) as { image_url?: { url?: string } } | undefined;
    expect(imagePart?.image_url?.url ?? '').toMatch(/^data:image\/png;base64,/);
    expect(ctx.model.uploads()).toEqual([]);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 60_000);

  it('a kimi-file image reference reaches kimi as an uploaded ms:// reference, never verbatim', async () => {
    const meta = await klient.global.files.save({
      data: new Uint8Array(Buffer.from(PNG_1X1_BASE64, 'base64')),
      filename: 'pasted-image.png',
      mimeType: 'image/png',
      expiresInSec: 3600,
    });
    const ctx = await newCase('kimi', 'kimifile-image-kimi');
    ctx.lane.script(say('OK'));
    await promptAndWait(ctx, [
      { type: 'image_url', imageUrl: { url: `kimi-file://${meta.id}` } },
      { type: 'text', text: 'what is this?' },
    ]);

    const uploads = ctx.model.uploads();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ purpose: 'image', state: 'stored' });
    expect(uploads[0]?.contentType).toContain('multipart/form-data');

    expect(ctx.model.requests()).toHaveLength(1);
    expect(JSON.stringify(ctx.body(0))).not.toContain(`kimi-file://${meta.id}`);
    const content = openAiMessages(ctx, 0).at(-1)?.['content'] as unknown[];
    const imagePart = content.find(
      (part) => (part as { type?: string }).type === 'image_url',
    ) as { image_url?: { url?: string } } | undefined;
    expect(imagePart?.image_url?.url ?? '').toBe(`ms://${uploads[0]!.id}`);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 60_000);
});

describe('video blocks', () => {
  it('video_url with an http URL passes through verbatim on every provider', async () => {
    const cases: Array<{
      label: string;
      kind: ProviderKind;
      assertBody: (body: unknown) => void;
    }> = [
      {
        label: 'video-url-openai',
        kind: 'openai',
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
        kind: 'kimi',
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
        kind: 'anthropic',
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
        kind: 'google',
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

    for (const { label, kind, assertBody } of cases) {
      const ctx = await newCase(kind, label);
      ctx.lane.script(say('OK'));
      await promptAndWait(ctx, [
        { type: 'text', text: 'describe this clip' },
        { type: 'video_url', videoUrl: { url: VIDEO_HTTP_URL } },
      ]);
      expect(ctx.model.requests(), label).toHaveLength(1);
      assertBody(ctx.body(0));
      expect(ctx.payloads('prompt.completed')[0]?.['reason'], label).toBe('completed');
    }
  }, 60_000);

  it('kimi (composed): ReadMediaFile on a video uploads via the files API (uploadVideo trait)', async () => {
    const ctx = await newCase('kimi', 'kimi-video-upload');
    await writeFile(join(ctx.workDir, 'clip.mp4'), Buffer.from(MP4_FTYP_HEX, 'hex'));
    ctx.lane.script(call('ReadMediaFile', { path: 'clip.mp4' }), say('OK'));

    await promptAndWait(ctx, [{ type: 'text', text: 'watch clip.mp4' }]);

    const uploads = ctx.model.uploads();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ purpose: 'video', filename: 'clip.mp4', state: 'stored' });
    expect(uploads[0]?.contentType).toContain('multipart/form-data');

    expect(ctx.model.requests()).toHaveLength(2);
    const secondBody = ctx.body(1) as { messages: Record<string, unknown>[] };
    const toolMessage = secondBody.messages.find((message) => message['role'] === 'tool');
    expect(JSON.stringify(toolMessage)).toContain(`ms://${uploads[0]!.id}`);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('kimi (composed): cancelling ReadMediaFile aborts the in-flight video upload', async () => {
    const ctx = await newCase('kimi', 'kimi-video-upload-cancel');
    await writeFile(
      join(ctx.workDir, 'clip.mp4'),
      Buffer.concat([Buffer.from(MP4_FTYP_HEX, 'hex'), Buffer.from([0])]),
    );
    ctx.model.holdUploads();
    ctx.lane.script(call('ReadMediaFile', { path: 'clip.mp4' }));

    const promptAborted = onceEvent(ctx.agent.events, 'prompt.aborted', 10_000);
    await ctx.agent.prompt({ input: [{ type: 'text', text: 'watch clip.mp4' }] });
    await waitFor(() => ctx.model.uploads().length === 1, 10_000);

    await ctx.agent.cancel();
    await promptAborted;

    await waitFor(() => ctx.model.uploads()[0]?.state === 'aborted', 2_000);
    expect(ctx.payloads('turn.ended')[0]?.['reason']).toBe('cancelled');
  }, 15_000);

  it('openai: no uploadVideo capability — the tool result is a path placeholder, no files call', async () => {
    const ctx = await newCase('openai-vision', 'openai-video-upload');
    await writeFile(join(ctx.workDir, 'clip.mp4'), Buffer.from(MP4_FTYP_HEX, 'hex'));
    ctx.lane.script(call('ReadMediaFile', { path: 'clip.mp4' }), say('OK'));

    await promptAndWait(ctx, [{ type: 'text', text: 'watch clip.mp4' }]);

    expect(ctx.model.uploads()).toEqual([]);
    expect(ctx.model.requests()).toHaveLength(2);
    const secondBody = ctx.body(1) as { messages: Record<string, unknown>[] };
    const toolMessage = secondBody.messages.find((message) => message['role'] === 'tool');
    expect(String(toolMessage?.['content'])).toContain('<video path=');
    expect(String(toolMessage?.['content'])).toContain('.mp4');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('anthropic: illegal base64 video mime throws in conversion; retryable, so stepRetry re-runs (l2)', async () => {
    await klient.global.config.set({ domain: 'loopControl', patch: { maxAttemptsPerStep: 2 } });
    try {
      const ctx = await newCase('anthropic', 'anthropic-video-mime');

      await promptAndWait(ctx, [
        { type: 'text', text: 'watch this' },
        { type: 'video_url', videoUrl: { url: VIDEO_BAD_MIME_URL } },
      ]);

      expect(ctx.model.requests()).toHaveLength(0);
      const turnEnded = ctx.payloads('turn.ended');
      expect(turnEnded).toHaveLength(1);
      expect(turnEnded[0]?.['reason']).toBe('failed');
      const wireError = turnEnded[0]?.['error'] as Record<string, unknown> | undefined;
      expect(wireError?.['code']).toBe('provider.api_error');
      expect(wireError?.['name']).toBe('ChatProviderError');
      expect(String(wireError?.['message'])).toContain('Unsupported media type for base64 video');

      const errorEvents = ctx.payloads('error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]?.['code']).toBe('provider.api_error');
      expect(ctx.eventNames()).toEqual(['turn.started', 'turn.ended', 'error', 'prompt.completed']);
      expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('failed');
    } finally {
      await klient.global.config.set({ domain: 'loopControl', patch: { maxAttemptsPerStep: 10 } });
    }
  }, 30_000);
});

describe('tool exchange structure', () => {
  it('openai: an unknown tool call still gets a paired (error) result on the wire', async () => {
    const ctx = await newCase('openai', 'openai-unknown-tool');
    ctx.lane.script(
      call('definitely_not_a_real_tool', {}, { id: 'call_unknown_1', invalid: true }),
      say('OK'),
    );
    await promptAndWait(ctx, [{ type: 'text', text: 'use the tool' }]);

    expect(ctx.model.requests()).toHaveLength(2);
    const messages = openAiMessages(ctx, 1);
    const assistant = messages.find(
      (message) => message['role'] === 'assistant' && message['tool_calls'] !== undefined,
    );
    expect(
      (assistant?.['tool_calls'] as { id: string }[]).map((toolCall) => toolCall.id),
    ).toContain('call_unknown_1');
    const toolMessage = messages.find(
      (message) => message['role'] === 'tool' && message['tool_call_id'] === 'call_unknown_1',
    );
    expect(toolMessage).toBeDefined();
    expect(String(toolMessage?.['content'])).toContain('definitely_not_a_real_tool');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 30_000);

  it('media tool result: plain openai extracts text + appends a media user message; kimi keeps parts in place', async () => {
    const runMediaToolResultCase = async (
      kind: ProviderKind,
      label: string,
    ): Promise<Record<string, unknown>[]> => {
      const ctx = await newCase(kind, label);
      await writeFile(join(ctx.workDir, 'pixel.png'), Buffer.from(PNG_1X1_BASE64, 'base64'));
      ctx.lane.script(call('ReadMediaFile', { path: 'pixel.png' }), say('OK'));
      await promptAndWait(ctx, [{ type: 'text', text: 'look at pixel.png' }]);
      expect(ctx.payloads('prompt.completed')[0]?.['reason'], label).toBe('completed');
      return openAiMessages(ctx, 1);
    };

    const openAiWire = await runMediaToolResultCase('openai-vision', 'media-result-openai');
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

    const kimiWire = await runMediaToolResultCase('kimi', 'media-result-kimi');
    const kimiTool = kimiWire.find((message) => message['role'] === 'tool');
    const kimiContent = kimiTool?.['content'] as { type: string }[];
    expect(Array.isArray(kimiContent)).toBe(true);
    expect(kimiContent.some((part) => part.type === 'image_url')).toBe(true);
    expect(kimiWire.at(-1)?.['role']).toBe('tool');
  }, 60_000);

  it('tool call ids are sanitized (64-char, safe charset) consistently across call and result', async () => {
    const nastyId = `call/bad id#${'x'.repeat(80)}`;
    const runIdCase = async (kind: ProviderKind, label: string): Promise<Record<string, unknown>[]> => {
      const ctx = await newCase(kind, label);
      ctx.lane.script(
        call('definitely_not_a_real_tool', {}, { id: nastyId, invalid: true }),
        say('OK'),
      );
      await promptAndWait(ctx, [{ type: 'text', text: 'use the tool' }]);
      expect(ctx.payloads('prompt.completed')[0]?.['reason'], label).toBe('completed');
      return openAiMessages(ctx, 1);
    };

    for (const [kind, label] of [
      ['openai', 'tool-id-openai'],
      ['kimi', 'tool-id-kimi'],
    ] as const) {
      const messages = await runIdCase(kind, label);
      const assistant = messages.find((message) => message['tool_calls'] !== undefined);
      const wireId = (assistant?.['tool_calls'] as { id: string }[])[0]?.id;
      expect(wireId, label).toBeDefined();
      expect(wireId!.length, label).toBeLessThanOrEqual(64);
      expect(wireId, label).toMatch(/^[a-zA-Z0-9_-]+$/);
      const toolMessage = messages.find((message) => message['role'] === 'tool');
      expect(toolMessage?.['tool_call_id'], label).toBe(wireId);
    }
  }, 60_000);

  it('after a user abort, an interruption reminder is on the wire before the next user message', async () => {
    const ctx = await newCase('openai', 'abort-merge');
    ctx.lane.unscripted('hang');

    const firstSettled = onceEvent(ctx.agent.events, 'prompt.aborted', 30_000);
    await ctx.agent.prompt({ input: [{ type: 'text', text: 'first message' }] });
    await waitFor(() => ctx.model.requests().length === 1, 10_000);
    await ctx.agent.cancel();
    await firstSettled;

    ctx.lane.script(say('OK'));
    await promptAndWait(ctx, [{ type: 'text', text: 'second message' }]);

    expect(ctx.model.requests()).toHaveLength(2);
    const userMessages = openAiMessages(ctx, 1).filter((message) => message['role'] === 'user');
    expect(userMessages).toHaveLength(3);
    expect(String(userMessages[0]?.['content'])).toContain('first message');
    expect(String(userMessages[1]?.['content'])).toContain('<system-reminder>');
    expect(String(userMessages[1]?.['content'])).toContain('interrupted by the user');
    expect(String(userMessages[2]?.['content'])).toContain('second message');
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
  }, 60_000);
});

describe('provider HTTP errors', () => {
  it('a non-recoverable 422 fails the turn with provider.api_error + statusCode on the wire (l3)', async () => {
    const ctx = await newCase('openai', 'openai-422');
    ctx.lane.script(httpError(422, { message: 'validation exploded on field messages' }));

    await promptAndWait(ctx, [{ type: 'text', text: 'hello' }]);

    expect(ctx.model.requests()).toHaveLength(1);
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
    const ctx = await newCase('openai', 'openai-400-strict');
    ctx.lane.script(httpError(400, { message: "tool_call_id 'call_x' not found" }), say('OK'));

    await promptAndWait(ctx, [{ type: 'text', text: 'hello' }]);

    expect(ctx.model.requests()).toHaveLength(2);
    expect(ctx.payloads('prompt.completed')[0]?.['reason']).toBe('completed');
    expect(ctx.payloads('error')).toHaveLength(0);
  }, 30_000);
});
