import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  IAgentTitlePromptSource,
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentToolPolicyService,
  IBootstrapService,
  IFileService,
  ISessionContext,
  ISessionMetadata,
  closeSessionById,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { projectPromptSnapshot, watchPromptSettlements } from '../src/routes/prompts';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
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

type PromptContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { kind: 'base64'; media_type: string; data: string };
    };

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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC32_TABLE = makeCrc32Table();

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function solidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) {
    const offset = 1 + x * 4;
    row[offset] = 0x33;
    row[offset + 1] = 0x66;
    row[offset + 2] = 0xcc;
    row[offset + 3] = 0xff;
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) {
    row.copy(raw, y * row.length);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('expected PNG data');
  }
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('expected IHDR as first PNG chunk');
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function readFileEventually(path: string): Promise<Buffer> {
  return vi.waitFor(() => readFile(path));
}

function sessionMediaDir(server: RunningServer, sessionId: string): string {
  const session = getLiveSessionById(server.core.accessor, sessionId);
  return join(session!.accessor.get(ISessionContext).sessionDir, 'media');
}

async function expectSessionMedia(
  server: RunningServer,
  sessionId: string,
  name: string,
  bytes: Buffer,
): Promise<string> {
  const path = join(sessionMediaDir(server, sessionId), name);
  expect(await readFileEventually(path)).toEqual(bytes);
  return path;
}

describe('server-v2 /api/v1 prompts', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-prompts-'));
    await writeFile(join(home, 'config.toml'), PROMPT_TOML, 'utf-8');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
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

  async function createMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
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

  it('submits a bundled skill prompt through the skills field', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'update-config' }, { name: 'check-kimi-code-docs' }],
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toMatch(/^msg_/);
    expect(['running', 'queued']).toContain(submitted.body.data.status);
    expect(submitted.body.data.content).toEqual([{ type: 'text', text: 'Review this change.' }]);

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    const bundled = history.find((message) => message.origin?.kind === 'user');
    expect(bundled?.origin).toMatchObject({
      kind: 'user',
      skillActivations: [{ skillName: 'update-config' }, { skillName: 'check-kimi-code-docs' }],
    });
    const texts = bundled?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text);
    expect(texts?.[texts.length - 1]).toBe('Review this change.');

    const projected = projectPromptSnapshot({
      id: 'msg_1',
      userMessageId: 'msg_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'running',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'rendered skill block' },
          { type: 'text', text: 'Review this change.' },
        ],
        toolCalls: [],
        origin: {
          kind: 'user',
          skillActivations: [{ activationId: 'a1', skillName: 'update-config' }],
        },
      },
    });
    expect(projected.content).toEqual([{ type: 'text', text: 'Review this change.' }]);
    const plain = projectPromptSnapshot({
      id: 'msg_2',
      userMessageId: 'msg_2',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'pending',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'plain question' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    expect(plain.content).toEqual([{ type: 'text', text: 'plain question' }]);
  });

  it('honors a client-chosen prompt_id on submit', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      prompt_id: 'submission-1',
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toBe('submission-1');
    expect(submitted.body.data.user_message_id).toBe('submission-1');
  });

  it('updates session metadata for a bundled prompt routed to a non-main agent', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const child = await session.accessor.get(IAgentLifecycleService).fork('main');

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'bundled side question' }],
      agent_id: child.id,
      skills: [{ name: 'update-config' }],
    });
    expect(submitted.body.code).toBe(0);

    expect((await session.accessor.get(ISessionMetadata).read()).lastPrompt).toBe(
      'bundled side question',
    );
  });

  it('rejects a reused prompt_id live and after cold resume without changing metadata', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const first = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'first prompt' }],
      prompt_id: 'submission-1',
    });
    expect(first.body.code).toBe(0);

    const duplicate = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'must not become metadata' }],
      prompt_id: 'submission-1',
    });
    expect(duplicate.body.code).toBe(40927);

    const session = getLiveSessionById(server!.core.accessor, id);
    expect((await session!.accessor.get(ISessionMetadata).read()).lastPrompt).toBe('first prompt');

    await closeSessionById(server!.core.accessor, id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();

    const afterResume = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'must not survive a cold resume' }],
      prompt_id: 'submission-1',
    });
    expect(afterResume.body.code).toBe(40927);
    const resumed = getLiveSessionById(server!.core.accessor, id);
    expect((await resumed!.accessor.get(ISessionMetadata).read()).lastPrompt).toBe('first prompt');
  });

  it('rejects a bundled submission with an unknown skill and records nothing', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    expect(history.filter((message) => message.origin?.kind === 'user')).toHaveLength(0);
  });

  it('rejects an unknown bundled skill before any control override binds', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      permission_mode: 'yolo',
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    expect(agent!.accessor.get(IAgentPermissionModeService).mode).toBe('manual');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    expect(history.filter((message) => message.origin?.kind === 'user')).toHaveLength(0);
  });

  it('rejects an unknown bundled skill without materializing the main agent', async () => {
    const id = await createSession(home as string);

    const submitted = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(server!.core.accessor, id);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('rejects a bundled prompt_id combination before any override or agent materialization', async () => {
    const id = await createSession(home as string);

    const submitted = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      permission_mode: 'yolo',
      prompt_id: 'submission-1',
      skills: [{ name: 'update-config' }],
    });
    expect(submitted.body.code).toBe(40001);

    const session = getLiveSessionById(server!.core.accessor, id);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('cleans bundled staging through the settlement tracker', async () => {
    const handlers: Array<(event: { type: string; promptId?: string; promptIds?: string[]; activePromptId?: string }) => void> = [];
    const events = {
      subscribe(
        handler: (event: { type: string; promptId?: string; promptIds?: string[]; activePromptId?: string }) => void,
      ) {
        handlers.push(handler);
        return { dispose: vi.fn() };
      },
    };

    const discard = vi.fn();
    const tracker = watchPromptSettlements(events as never);
    tracker.settle('msg_1', discard);
    handlers[0]!({ type: 'prompt.completed', promptId: 'msg_other' });
    handlers[0]!({ type: 'turn.started' });
    expect(discard).not.toHaveBeenCalled();
    handlers[0]!({ type: 'prompt.completed', promptId: 'msg_1' });
    expect(discard).toHaveBeenCalledTimes(1);

    const blockedDiscard = vi.fn();
    const blockedTracker = watchPromptSettlements(events as never);
    handlers[1]!({ type: 'prompt.completed', promptId: 'msg_blocked' });
    blockedTracker.settle('msg_blocked', blockedDiscard);
    expect(blockedDiscard).toHaveBeenCalledTimes(1);

    const steered = vi.fn();
    const steeredTracker = watchPromptSettlements(events as never);
    steeredTracker.settle('msg_3', steered);
    handlers[2]!({ type: 'prompt.steered', promptIds: ['msg_3'], activePromptId: 'msg_parent' });
    expect(steered).not.toHaveBeenCalled();
    handlers[2]!({ type: 'prompt.completed', promptId: 'msg_other' });
    expect(steered).not.toHaveBeenCalled();
    handlers[2]!({ type: 'prompt.completed', promptId: 'msg_parent' });
    expect(steered).toHaveBeenCalledTimes(1);

    const aborted = vi.fn();
    const abortedTracker = watchPromptSettlements(events as never);
    abortedTracker.settle('msg_4', aborted);
    handlers[3]!({ type: 'prompt.aborted', promptId: 'msg_4' });
    expect(aborted).toHaveBeenCalledTimes(1);

    const rejected = vi.fn();
    const rejectedTracker = watchPromptSettlements(events as never);
    rejectedTracker.settle('msg_5', rejected);
    rejectedTracker.dispose();
    handlers[4]!({ type: 'prompt.completed', promptId: 'msg_5' });
    expect(rejected).not.toHaveBeenCalled();
  });

  it('makes the first three REST prompts available to title generation', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const prompts = ['先搭一个 Vite 项目', '加上路由', '现在配一下 ESLint'];
    for (const text of prompts) {
      const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
        content: [{ type: 'text', text }],
      });
      expect(submitted.body.code).toBe(0);
    }

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session?.accessor.get(IAgentLifecycleService).get('main');
    const source = agent?.accessor.get(IAgentTitlePromptSource);
    expect(source).toBeDefined();
    await expect(source!.firstUserPrompts(3)).resolves.toEqual(prompts);
  });

  it('rejects a stale file reference without creating the agent or mutating the model', async () => {
    const id = await createSession(home as string);
    const session = getLiveSessionById(server!.core.accessor, id);

    const { body } = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      model: 'stub',
      content: [
        { type: 'text', text: 'look' },
        { type: 'video', source: { kind: 'file', file_id: 'f_does_not_exist' } },
      ],
    });
    expect(body.code).toBe(40407);

    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('rejects a mis-kinded file reference without creating the agent', async () => {
    const id = await createSession(home as string);
    const session = getLiveSessionById(server!.core.accessor, id);

    const form = new FormData();
    form.set('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'spec.pdf');
    const uploadRes = await fetch(`${base}/api/v1/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const { body } = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      model: 'stub',
      content: [
        { type: 'text', text: 'watch this' },
        { type: 'video', source: { kind: 'file', file_id: uploaded.data.id } },
      ],
    });
    expect(body.code).toBe(40001);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('carries an uploaded video into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const videoBytes = Buffer.from('tiny fake mp4 bytes');
    const form = new FormData();
    form.set('file', new Blob([videoBytes], { type: 'video/mp4' }), 'clip.mp4');
    const uploadRes = await fetch(`${base}/api/v1/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'what happens in this video?' },
        { type: 'video', source: { kind: 'file', file_id: uploaded.data.id } },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'what happens in this video?' });
    expect(content[1]).toEqual({
      type: 'video',
      source: { kind: 'session_media', file_id: uploaded.data.id },
    });

    await expectSessionMedia(server!, id, `${uploaded.data.id}.mp4`, videoBytes);
  });

  it('carries a compressed uploaded image into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const bigPng = solidPng(3600, 1800);
    const uploaded = await uploadFile(bigPng, 'image/png', 'big.png');
    expect(uploaded.size).toBe(bigPng.length);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    const caption = content[0] as { type: string; text: string };
    expect(caption.type).toBe('text');
    expect(caption.text).toContain('Image compressed');
    expect(caption.text).toContain('3600x1800');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!).toContain('/media-originals/');
    expect(await readFile(pathMatch![1]!)).toEqual(bigPng);

    const image = content[1] as { type: string; source: { kind: string; file_id: string } };
    expect(image.type).toBe('image');
    expect(image.source.kind).toBe('session_media');
    const finalFileId = image.source.file_id;
    expect(finalFileId).not.toBe(uploaded.id);

    const mediaPath = join(sessionMediaDir(server!, id), `${finalFileId}.png`);
    expect(pngDimensions(await readFileEventually(mediaPath))).toEqual({ width: 2000, height: 1000 });
    expect(JSON.stringify(content)).not.toContain(mediaPath);

    const original = await server!.core.accessor.get(IFileService).get(uploaded.id);
    expect(original.meta.size).toBe(bigPng.length);

    const files = server!.core.accessor.get(IFileService);
    await vi.waitFor(async () => {
      const result = await files.get(finalFileId).catch((error: unknown) => error);
      expect(result).toMatchObject({ code: 'file.not_found' });
    });

    expect(JSON.stringify(content)).not.toContain('kimi-file://');

    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
    const memory = main.accessor.get(IAgentContextMemoryService).get();
    const reminder = memory.find((m) => m.origin?.kind === 'injection');
    const reminderText = reminder?.content[0];
    expect(reminderText?.type).toBe('text');
    expect((reminderText as { type: 'text'; text: string }).text).toContain('<system-reminder>');
    expect((reminderText as { type: 'text'; text: string }).text).toContain('Image compressed');
  });

  it('rolls back a compressed upload when a later prompt part fails to resolve', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const first = await uploadFile(solidPng(3600, 1800), 'image/png', 'big.png');
    const second = await uploadFile(solidPng(10, 10), 'image/png', 'small.png');
    const files = server!.core.accessor.get(IFileService);
    const originalGet = files.get.bind(files);
    const originalSave = files.save.bind(files);
    let secondGets = 0;
    let compressedFileId: string | undefined;
    const getSpy = vi.spyOn(files, 'get').mockImplementation(async (fileId) => {
      if (fileId === second.id && ++secondGets === 2) {
        throw new Error('injected second-part failure');
      }
      return originalGet(fileId);
    });
    const saveSpy = vi.spyOn(files, 'save').mockImplementation(async (...args) => {
      const saved = await originalSave(...args);
      compressedFileId = saved.id;
      return saved;
    });

    try {
      const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
        content: [
          { type: 'image', source: { kind: 'file', file_id: first.id } },
          { type: 'image', source: { kind: 'file', file_id: second.id } },
        ],
      });

      expect(submitted.body.code).not.toBe(0);
      expect(compressedFileId).toBeDefined();
      if (compressedFileId === undefined) throw new Error('expected a compressed upload');
      await expect(originalGet(compressedFileId)).rejects.toMatchObject({
        code: 'file.not_found',
      });
    } finally {
      getSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });

  it('carries an uncompressed uploaded image into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: 'image', source: { kind: 'session_media', file_id: uploaded.id } },
    ]);

    const mediaPath = await expectSessionMedia(server!, id, `${uploaded.id}.png`, smallPng);
    expect(JSON.stringify(content)).not.toContain(mediaPath);

    expect(JSON.stringify(content)).not.toContain('kimi-file://');
  });

  it('accepts a stored session-media reference after the transient upload is deleted', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const first = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(first.body.code).toBe(0);
    await expectSessionMedia(server!, id, `${uploaded.id}.png`, smallPng);
    await server!.core.accessor.get(IFileService).delete(uploaded.id);

    const replayed = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'replay the stored image' },
        { type: 'image', source: { kind: 'session_media', file_id: uploaded.id } },
      ],
    });

    expect(replayed.body.code).toBe(0);
    expect(replayed.body.data.content).toEqual([
      { type: 'text', text: 'replay the stored image' },
      { type: 'image', source: { kind: 'session_media', file_id: uploaded.id } },
    ]);

    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
    await vi.waitFor(() => {
      const replayedMessage = main.accessor
        .get(IAgentContextMemoryService)
        .get()
        .find(
          (message) =>
            message.role === 'user' &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'replay the stored image',
            ),
        );
      expect(replayedMessage).toBeDefined();
      expect(replayedMessage!.content).toContainEqual({
        type: 'image_url',
        imageUrl: {
          url: `kimi-file://${uploaded.id}`,
        },
      });
    });
  });

  it('keeps the upload-backed reference when the session media dir is not writable', async () => {
    if (process.getuid?.() === 0) return;
    const id = await createSession(home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const mediaDir = sessionMediaDir(server!, id);
    await mkdir(mediaDir, { recursive: true });
    await chmod(mediaDir, 0o555);
    try {
      const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
        content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
      });
      expect(submitted.body.code).toBe(0);

      const session = getLiveSessionById(server!.core.accessor, id);
      const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
      await vi.waitFor(() => {
        const message = main.accessor
          .get(IAgentContextMemoryService)
          .get()
          .find((m) => m.role === 'user' && m.content.some((part) => part.type === 'image_url'));
        expect(message).toBeDefined();
        expect(message!.content).toContainEqual({
          type: 'image_url',
          imageUrl: { url: `kimi-file://${uploaded.id}` },
        });
      });

      const cacheDir = server!.core.accessor.get(IBootstrapService).cacheDir;
      await expect(readFile(join(cacheDir, `${uploaded.id}.png`))).rejects.toThrow();
    } finally {
      await chmod(mediaDir, 0o755);
    }
  });

  it('compresses inline base64 image prompts into session media-originals', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const bigPng = solidPng(3600, 1800);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/png',
            data: bigPng.toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(2);
    const caption = content[0];
    if (caption?.type !== 'text') throw new Error('expected compression caption');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!).toContain('/media-originals/');
    expect((await realpath(pathMatch![1]!)).startsWith(await realpath(home as string))).toBe(true);
    expect(await readFile(pathMatch![1]!)).toEqual(bigPng);

    const image = content[1];
    if (image?.type !== 'image' || image.source.kind !== 'base64') {
      throw new Error('expected resolved base64 image');
    }
    expect(pngDimensions(Buffer.from(image.source.data, 'base64'))).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  function avifBytes(): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write('avif', 8, 'latin1');
    buf.write('avif', 16, 'latin1');
    return buf;
  }

  it('replaces an inline base64 image in an unsupported format with a text notice', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/png',
            data: avifBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    const notice = content[0];
    if (notice?.type !== 'text') throw new Error('expected a text notice');
    expect(notice.text).toContain('image/avif');
  });

  it('replaces an uploaded image file in an unsupported format with a text notice', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const form = new FormData();
    form.set('file', new Blob([avifBytes()], { type: 'image/avif' }), 'photo.avif');
    const uploadRes = await fetch(`${base}/api/v1/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.data.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    const notice = content[0];
    if (notice?.type !== 'text') throw new Error('expected a text notice');
    expect(notice.text).toContain('image/avif');
    expect(notice.text).toContain('photo.avif');
  });

  it('replaces a remote image URL with an unsupported extension with a text notice', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'url', url: 'https://example.com/pic.avif' } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    const notice = content[0];
    if (notice?.type !== 'text') throw new Error('expected a text notice');
    expect(notice.text).toContain('image/avif');
    expect(notice.text).toContain('https://example.com/pic.avif');
  });

  async function uploadFile(
    bytes: Buffer,
    mediaType: string,
    name: string,
  ): Promise<{ id: string; size: number }> {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: mediaType }), name);
    const uploadRes = await fetch(`${base}/api/v1/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string; size: number }>;
    expect(uploaded.code).toBe(0);
    return uploaded.data;
  }

  function attachedPathFrom(notice: string): string {
    const match = /bytes\): (.+) — open it with the Read tool$/.exec(notice);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  it('materializes an arbitrary file attachment into the session attachments dir', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const pdfBytes = Buffer.from('%PDF-1.4 fake pdf bytes');
    const uploaded = await uploadFile(pdfBytes, 'application/pdf', 'report.pdf');

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'summarize this' },
        { type: 'file', file_id: uploaded.id, name: 'report.pdf', media_type: 'application/pdf', size: pdfBytes.length },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'summarize this' });
    const notice = content[1];
    expect(notice?.type).toBe('text');
    expect(notice?.text).toContain('Attached file "report.pdf"');
    expect(notice?.text).toContain('application/pdf');
    expect(notice?.text).toContain(`${pdfBytes.length} bytes`);
    const attachedPath = attachedPathFrom(notice?.text ?? '');
    expect(attachedPath).toContain('/attachments/');
    expect(attachedPath.endsWith(`${uploaded.id}-report.pdf`)).toBe(true);
    expect((await realpath(attachedPath)).startsWith(await realpath(home as string))).toBe(true);
    expect(await readFile(attachedPath)).toEqual(pdfBytes);
  });

  it('materializes an uploaded SVG image as a path-referenced attachment', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const uploaded = await uploadFile(svgBytes, 'image/svg+xml', 'vector.svg');

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    const notice = content[0];
    expect(notice?.type).toBe('text');
    expect(notice?.text).not.toContain('[Image omitted');
    expect(notice?.text).toContain('"vector.svg"');
    expect(notice?.text).toContain('image/svg+xml');
    const attachedPath = attachedPathFrom(notice?.text ?? '');
    expect(attachedPath).toContain('/attachments/');
    expect(attachedPath.endsWith(`${uploaded.id}-vector.svg`)).toBe(true);
    expect(await readFile(attachedPath)).toEqual(svgBytes);
  });

  it('persists an inline base64 image in an unsupported format as a path-referenced attachment', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const data = avifBytes();

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/avif',
            data: data.toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    const notice = content[0];
    expect(notice?.type).toBe('text');
    expect(notice?.text).not.toContain('[Image omitted');
    expect(notice?.text).toContain('"image.avif"');
    expect(notice?.text).toContain('image/avif');
    const attachedPath = attachedPathFrom(notice?.text ?? '');
    expect(attachedPath).toContain('/attachments/');
    expect(attachedPath.endsWith('-image.avif')).toBe(true);
    expect(await readFile(attachedPath)).toEqual(data);
  });

  it('sanitizes an attachment file name before materializing it', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const scriptBytes = Buffer.from('#!/bin/sh\necho hi');
    const uploaded = await uploadFile(scriptBytes, 'text/plain', '../../etc/evil.sh');

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [
        { type: 'file', file_id: uploaded.id, name: '../../etc/evil.sh', media_type: 'text/plain', size: scriptBytes.length },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    const attachedPath = attachedPathFrom(content[0]?.text ?? '');
    expect(dirname(attachedPath).endsWith('/attachments')).toBe(true);
    expect((await realpath(attachedPath)).startsWith(await realpath(home as string))).toBe(true);
    expect(await readFile(attachedPath)).toEqual(scriptBytes);
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
    await closeSessionById(server!.core.accessor, id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();

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

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.fork('main');

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'side question' }],
      agent_id: child.id,
    });
    expect(submitted.body.code).toBe(0);

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

    expect(contextHasUserText(child, 'side question')).toBe(true);

    const main = lifecycle.get('main');
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

  it('rejects an unknown agent profile with 40001', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent_does_not_exist',
      model: 'stub',
    });
    expect(body.code).toBe(40001);
    expect(body.msg).toContain('agent_does_not_exist');
  });

  it('binds a discovered custom agent profile on the first prompt', async () => {
    await mkdir(join(home as string, 'agents'), { recursive: true });
    await writeFile(
      join(home as string, 'agents', 'route-reviewer.md'),
      [
        '---',
        'name: route-reviewer',
        'description: reviewer defined by a user-level agent file',
        '---',
        '',
        'You are a route-test reviewer.',
        '',
      ].join('\n'),
      'utf-8',
    );
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'route-reviewer',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    expect(main?.accessor.get(IAgentProfileService).data().profileName).toBe('route-reviewer');

    const again = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
      profile: 'route-reviewer',
    });
    expect(again.body.code).toBe(0);
  });

  it('rejects switching to a different profile once bound', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const first = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
    });
    expect(first.body.code).toBe(0);

    const { body } = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
      profile: 'some-other-agent',
      model: 'stub',
    });
    expect(body.code).toBe(40001);
    expect(body.msg).toContain('already bound');
  });

  it('applies a requested thinking effort together with the profile bind', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent',
      model: 'stub',
      thinking: 'high',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    const profile = main?.accessor.get(IAgentProfileService);
    expect(profile?.data().profileName).toBe('agent');
    expect(profile?.data().thinkingLevel).toBe('high');
  });

  it('applies disabled_tools on the first prompt and replaces them on later prompts', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const toolPolicy = session.accessor.get(IAgentLifecycleService).get('main')?.accessor
      .get(IAgentToolPolicyService);
    expect(toolPolicy?.isToolActive('Bash')).toBe(false);
    expect(toolPolicy?.isToolActive('Read')).toBe(true);

    const replaced = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
      disabled_tools: ['Write'],
    });
    expect(replaced.body.code).toBe(0);
    expect(toolPolicy?.isToolActive('Bash')).toBe(true);
    expect(toolPolicy?.isToolActive('Write')).toBe(false);

    const cleared = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'once more' }],
      disabled_tools: [],
    });
    expect(cleared.body.code).toBe(0);
    expect(toolPolicy?.isToolActive('Write')).toBe(true);
  });

  it('shares disabled_tools with agents created after the request', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const child = await session.accessor.get(IAgentLifecycleService).create({
      binding: {
        profile: 'coder',
        model: 'stub',
      },
    });

    const childToolPolicy = child.accessor.get(IAgentToolPolicyService);
    expect(childToolPolicy.isToolActive('Bash')).toBe(false);
    expect(childToolPolicy.isToolActive('Read')).toBe(true);
  });

  it('rejects disabled_tools before the agent profile is bound', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      disabled_tools: ['Bash'],
    });
    expect(body.code).toBe(40001);
  });

  it('persists disabled_tools across a cold resume', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    await closeSessionById(server!.core.accessor, id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();

    const again = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
    });
    expect(again.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const toolPolicy = session.accessor.get(IAgentLifecycleService).get('main')?.accessor
      .get(IAgentToolPolicyService);
    expect(toolPolicy?.isToolActive('Bash')).toBe(false);
    expect(toolPolicy?.isToolActive('Read')).toBe(true);
  });
});
