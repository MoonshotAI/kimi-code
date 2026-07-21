import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentToolPolicyService,
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA

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

  it('rejects a stale file reference without creating the agent or mutating the model', async () => {
    const id = await createSession(home as string);
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);

    const { body } = await call<null>('POST', `/api/v1/sessions/${id}/prompts`, {
      model: 'stub',
      content: [
        { type: 'text', text: 'look' },
        { type: 'video', source: { kind: 'file', file_id: 'f_does_not_exist' } },
      ],
    });
    expect(body.code).toBe(40407);

    // The failed request must not have materialized the main agent either.
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('rejects a mis-kinded file reference without creating the agent', async () => {
    const id = await createSession(home as string);
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);

    // A real upload, but referenced with the wrong media kind.
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

  it('falls back to cache path tags for uploaded videos when the model has no upload channel', async () => {
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

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'what happens in this video?' });
    expect(content[1]?.type).toBe('text');
    const match = /<video path="([^"]+)"><\/video>/.exec(content[1]?.text ?? '');
    expect(match).not.toBeNull();
    const cachePath = match![1]!;
    expect(cachePath.startsWith(join(home as string, 'cache'))).toBe(true);
    expect(cachePath.endsWith('.mp4')).toBe(true);
    expect(await readFile(cachePath)).toEqual(videoBytes);
  });

  it('compresses uploaded image prompts into base64 image parts with a readback caption', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const bigPng = solidPng(3600, 1800);
    const form = new FormData();
    form.set('file', new Blob([bigPng], { type: 'image/png' }), 'big.png');
    const uploadRes = await fetch(`${base}/api/v1/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string; size: number }>;
    expect(uploaded.code).toBe(0);
    expect(uploaded.data.size).toBe(bigPng.length);

    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.data.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(2);
    const caption = content[0];
    if (caption?.type !== 'text') throw new Error('expected compression caption');
    expect(caption.text).toContain('Image compressed');
    expect(caption.text).toContain('3600x1800');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!).toContain('/media-originals/');
    expect(await readFile(pathMatch![1]!)).toEqual(bigPng);

    const image = content[1];
    if (image?.type !== 'image' || image.source.kind !== 'base64') {
      throw new Error('expected resolved base64 image');
    }
    expect(image.source.media_type).toBe('image/png');
    expect(pngDimensions(Buffer.from(image.source.data, 'base64'))).toEqual({
      width: 2000,
      height: 1000,
    });
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
    // Minimal ftyp box: size(4) + 'ftyp' + major_brand 'avif' + minor(4) + compat(8).
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write('avif', 8, 'latin1');
    buf.write('avif', 16, 'latin1');
    return buf;
  }

  it('replaces an inline base64 image in an unsupported format with a text notice', async () => {
    // An AVIF payload (accepted by no provider) must never enter the session
    // history as an image part — the bytes are authoritative, so even a
    // mislabeled media_type is gated on the sniffed format.
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
    // The notice keeps the URL so the model can fetch and convert the image.
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

  // The path-reference notice for a materialized attachment ends with the
  // absolute path: `Attached file "<name>" (<mime>, <n> bytes): <path> — open
  // it with the Read tool`.
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
    // SVG is not a provider-accepted image format, but the bytes are still the
    // user's content: keep them as a file the model can open by path instead
    // of dropping them with an "[Image omitted]" notice.
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
    // No original name exists for inline base64 — it is derived from the
    // sniffed format and the file is addressed by content hash.
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
    // The materialized file must stay inside the session's attachments dir —
    // the `../` segments in the original name can never escape it.
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
    // A user-level agent file under $KIMI_CODE_HOME/agents is discovered into
    // the session profile catalog and selectable by name.
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

    // No `model` — the profile bind falls back to the configured default_model.
    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'route-reviewer',
    });
    expect(submitted.body.code).toBe(0);

    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    expect(main?.accessor.get(IAgentProfileService).data().profileName).toBe('route-reviewer');

    // Repeating the same profile on a later prompt is a no-op, not an error.
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

    // `thinking` rides along in the bind: the effort is validated up front
    // and applied with the first bind, not by a separate setThinking after.
    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent',
      model: 'stub',
      thinking: 'high',
    });
    expect(submitted.body.code).toBe(0);

    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    const profile = main?.accessor.get(IAgentProfileService);
    expect(profile?.data().profileName).toBe('agent');
    expect(profile?.data().thinkingLevel).toBe('high');
  });

  it('applies disabled_tools on the first prompt and replaces them on later prompts', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    // model:'stub' lazily binds the default profile before the route applies
    // disabled_tools (a session denylist requires a bound profile).
    const submitted = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const toolPolicy = session.accessor.get(IAgentLifecycleService).get('main')?.accessor
      .get(IAgentToolPolicyService);
    expect(toolPolicy?.isToolActive('Bash')).toBe(false);
    expect(toolPolicy?.isToolActive('Read')).toBe(true);

    // Each submission fully replaces the client-managed portion.
    const replaced = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
      disabled_tools: ['Write'],
    });
    expect(replaced.body.code).toBe(0);
    expect(toolPolicy?.isToolActive('Bash')).toBe(true);
    expect(toolPolicy?.isToolActive('Write')).toBe(false);

    // An empty list clears the client-managed portion.
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

    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
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

    // No profile/model: the agent stays unbound, and a session denylist cannot
    // be computed before bind (a later bind would silently overwrite it).
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

    // Drop the live handle; the next submit cold-resumes the session from disk.
    await server!.core.accessor.get(ISessionLifecycleService).close(id);
    expect(server!.core.accessor.get(ISessionLifecycleService).get(id)).toBeUndefined();

    const again = await call<PromptItemWire>('POST', `/api/v1/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
    });
    expect(again.body.code).toBe(0);

    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const toolPolicy = session.accessor.get(IAgentLifecycleService).get('main')?.accessor
      .get(IAgentToolPolicyService);
    expect(toolPolicy?.isToolActive('Bash')).toBe(false);
    expect(toolPolicy?.isToolActive('Read')).toBe(true);
  });
});

describe('server-v2 /api/v1 prompts with a video-upload-capable model', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let stubClose: (() => Promise<void>) | undefined;
  let stubBodies: Buffer[];
  let uploadGate: Promise<void> | null;

  function kimiToml(stubUrl: string): string {
    return [
      'default_model = "stub"',
      '',
      '[providers.stub]',
      'type = "kimi"',
      `base_url = "${stubUrl}"`,
      'api_key = "stub"',
      '',
      '[models.stub]',
      'provider = "stub"',
      'model = "stub"',
      'max_context_size = 1000',
      'capabilities = [ "video_in", "image_in" ]',
      '',
      '[models.stub2]',
      'provider = "stub"',
      'model = "stub2"',
      'max_context_size = 1000',
      'capabilities = [ "video_in", "image_in" ]',
      '',
    ].join('\n');
  }

  beforeEach(async () => {
    stubBodies = [];
    uploadGate = null;
    let uploadCounter = 0;
    const pendingGenerations: ServerResponse[] = [];
    const stub = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/files') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          void (async () => {
            if (uploadGate !== null) {
              const gate = uploadGate;
              uploadGate = null;
              await gate;
            }
            uploadCounter += 1;
            stubBodies.push(Buffer.concat(chunks));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: `stub-llm-video-${String(uploadCounter)}`,
                object: 'file',
                bytes: 17,
                created_at: 0,
                filename: 'clip.mp4',
                purpose: 'video',
              }),
            );
          })();
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        // Hang until the turn is aborted: an answered request (404 or a
        // completed stream) can end the turn before the test's abort lands,
        // making the cleanup racy.
        pendingGenerations.push(res);
        req.on('close', () => {
          const index = pendingGenerations.indexOf(res);
          if (index >= 0) pendingGenerations.splice(index, 1);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const { port } = stub.address() as AddressInfo;
    stubClose = () =>
      new Promise<void>((resolve) => {
        for (const pending of pendingGenerations.splice(0)) pending.destroy();
        stub.close(() => resolve());
      });

    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-prompts-kimi-'));
    await writeFile(join(home, 'config.toml'), kimiToml(`http://127.0.0.1:${String(port)}`), 'utf-8');
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (stubClose !== undefined) {
      await stubClose();
      stubClose = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function createSessionWithAgent(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    const session = server!.core.accessor.get(ISessionLifecycleService).get(body.data.id);
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    return body.data.id;
  }

  async function uploadVideoFile(name: string, bytes: Buffer): Promise<string> {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: 'video/mp4' }), name);
    const res = await fetch(`${base}/api/v1/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function submitVideoPrompt(sessionId: string, fileIds: string[]): Promise<Envelope<PromptItemWire>> {
    const res = await fetch(`${base}/api/v1/sessions/${sessionId}/prompts`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        // The prompt-time model override is applied before media resolution,
        // so the video uploader is built from this model.
        model: 'stub',
        content: [
          { type: 'text', text: 'what happens in this video?' },
          ...fileIds.map((fileId) => ({ type: 'video', source: { kind: 'file', file_id: fileId } })),
        ],
      }),
    } as never);
    const body = (await res.json()) as Envelope<PromptItemWire>;
    expect(body.code).toBe(0);
    return body;
  }

  async function abortPrompt(sessionId: string, promptId: string): Promise<void> {
    // The stub serves no generation, so the turn keeps retrying in the
    // background; abort it deterministically to let the server close.
    const res = await fetch(`${base}/api/v1/sessions/${sessionId}/prompts/${promptId}:abort`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
  }

  async function redirectOf(llmId: string): Promise<{ status: number; location: string | null }> {
    const res = await fetch(`${base}/api/v1/files/llm/${llmId}`, {
      headers: authHeaders(server as RunningServer),
      redirect: 'manual',
    } as never);
    return { status: res.status, location: res.headers.get('location') };
  }

  it('inlines an uploaded video prompt as the provider-issued reference', async () => {
    const id = await createSessionWithAgent();
    const videoBytes = Buffer.from('tiny fake mp4 bytes');
    const fileId = await uploadVideoFile('clip.mp4', videoBytes);

    const submitted = await submitVideoPrompt(id, [fileId]);

    // The prompt carries the provider-issued reference, not a path tag.
    const content = submitted.data.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'what happens in this video?' });
    expect(content[1]).toEqual({
      type: 'video',
      source: { kind: 'url', url: 'ms://stub-llm-video-1', id: 'stub-llm-video-1' },
    });

    // The upload happened synchronously, before the prompt was accepted, and
    // carried the video bytes.
    expect(stubBodies).toHaveLength(1);
    expect(stubBodies[0]!.includes(videoBytes)).toBe(true);

    // The provider id maps back to the local upload for playback.
    const { status, location } = await redirectOf('stub-llm-video-1');
    expect(status).toBe(302);
    expect(location).toBe(`/api/v1/files/${fileId}`);

    const downloadRes = await fetch(`${base}${location}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(downloadRes.status).toBe(200);
    expect(Buffer.from(await downloadRes.arrayBuffer())).toEqual(videoBytes);

    await abortPrompt(id, submitted.data.prompt_id);
  });

  it('maps each inlined video back to its own upload', async () => {
    const id = await createSessionWithAgent();
    const fileA = await uploadVideoFile('a.mp4', Buffer.from('video-A'));
    const fileB = await uploadVideoFile('b.mp4', Buffer.from('video-B'));

    const submitted = await submitVideoPrompt(id, [fileA, fileB]);

    expect(stubBodies).toHaveLength(2);
    const content = submitted.data.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: 'video',
      source: { kind: 'url', url: 'ms://stub-llm-video-1', id: 'stub-llm-video-1' },
    });
    expect(content[2]).toEqual({
      type: 'video',
      source: { kind: 'url', url: 'ms://stub-llm-video-2', id: 'stub-llm-video-2' },
    });
    expect((await redirectOf('stub-llm-video-1')).location).toBe(`/api/v1/files/${fileA}`);
    expect((await redirectOf('stub-llm-video-2')).location).toBe(`/api/v1/files/${fileB}`);

    await abortPrompt(id, submitted.data.prompt_id);
  });

  it('serves range requests through the llm redirect', async () => {
    const id = await createSessionWithAgent();
    const fileId = await uploadVideoFile('clip.mp4', Buffer.from('0123456789'));

    const submitted = await submitVideoPrompt(id, [fileId]);

    const { location } = await redirectOf('stub-llm-video-1');
    const rangeRes = await fetch(`${base}${location}`, {
      headers: { ...authHeaders(server as RunningServer), range: 'bytes=2-5' },
    } as never);
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(Buffer.from(await rangeRes.arrayBuffer()).toString()).toBe('2345');

    await abortPrompt(id, submitted.data.prompt_id);
  });

  it('falls back to the tag form when an uploaded "video" sniffs as another kind', async () => {
    const id = await createSessionWithAgent();
    // Declared video/mp4 at upload time, but the bytes are a PNG (magic
    // bytes are authoritative; a text lookalike would be indistinguishable
    // from MPEG-PS and is the provider's call, same as ReadMediaFile).
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const fileId = await uploadVideoFile('clip.mp4', pngBytes);

    const submitted = await submitVideoPrompt(id, [fileId]);

    // No provider upload is attempted for bytes sniffed as a non-video kind.
    expect(stubBodies).toHaveLength(0);
    const content = submitted.data.content as Array<Record<string, unknown>>;
    expect(content[1]?.['type']).toBe('text');
    expect(String(content[1]?.['text'])).toMatch(/<video path="[^"]+"><\/video>/);

    await abortPrompt(id, submitted.data.prompt_id);
  });

  it('rejects the submission when the model switches mid-upload', async () => {
    const id = await createSessionWithAgent();
    const fileId = await uploadVideoFile('clip.mp4', Buffer.from('0123456789'));

    let releaseUpload!: () => void;
    uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const submit = fetch(`${base}/api/v1/sessions/${id}/prompts`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        model: 'stub',
        content: [
          { type: 'text', text: 'watch this' },
          { type: 'video', source: { kind: 'file', file_id: fileId } },
        ],
      }),
    } as never);

    // A concurrent model switch lands while the upload is parked.
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main')!;
    await agent.accessor.get(IAgentProfileService).setModel('stub2');
    releaseUpload();

    const body = (await (await submit).json()) as Envelope<null>;
    expect(body.code).toBe(40901);
  });

  it('inlines videos on a first prompt that binds a profile without an explicit model', async () => {
    const id = await createSessionWithAgent();
    const videoBytes = Buffer.from('tiny fake mp4 bytes');
    const fileId = await uploadVideoFile('clip.mp4', videoBytes);

    // `profile` without `model`: the uploader must resolve the configured
    // default model (video-capable) instead of falling back to a path tag.
    const submitRes = await fetch(`${base}/api/v1/sessions/${id}/prompts`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        profile: 'agent',
        content: [
          { type: 'text', text: 'what happens in this video?' },
          { type: 'video', source: { kind: 'file', file_id: fileId } },
        ],
      }),
    } as never);
    const submitted = (await submitRes.json()) as Envelope<PromptItemWire>;
    expect(submitted.code).toBe(0);

    const content = submitted.data.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: 'video',
      source: { kind: 'url', url: 'ms://stub-llm-video-1', id: 'stub-llm-video-1' },
    });
    expect(stubBodies).toHaveLength(1);

    await abortPrompt(id, submitted.data.prompt_id);
  });

  it('serializes concurrent submissions so a media upload cannot be overtaken', async () => {
    const id = await createSessionWithAgent();
    const fileId = await uploadVideoFile('clip.mp4', Buffer.from('0123456789'));

    // Gate the provider upload: the video submit parks inside media
    // resolution while a later text submit races it.
    let releaseUpload!: () => void;
    uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const first = submitVideoPrompt(id, [fileId]);
    const second = fetch(`${base}/api/v1/sessions/${id}/prompts`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ content: [{ type: 'text', text: 'follow-up' }] }),
    } as never);
    await new Promise((r) => setTimeout(r, 100));
    releaseUpload();

    const [firstSubmitted, secondRes] = await Promise.all([first, second]);
    const secondSubmitted = (await secondRes.json()) as Envelope<PromptItemWire>;
    expect(firstSubmitted.code).toBe(0);
    expect(secondSubmitted.code).toBe(0);

    // The video prompt holds the active slot; the follow-up waits behind it
    // in the queue instead of overtaking.
    const listRes = await fetch(`${base}/api/v1/sessions/${id}/prompts`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const list = ((await listRes.json()) as Envelope<{
      active: { prompt_id: string } | null;
      queued: Array<{ prompt_id: string }>;
    }>).data;
    expect(list.active?.prompt_id).toBe(firstSubmitted.data.prompt_id);
    expect(list.queued.map((p) => p.prompt_id)).toEqual([secondSubmitted.data.prompt_id]);

    await abortPrompt(id, firstSubmitted.data.prompt_id);
  });

  it('keeps the llm video mapping across a server restart', async () => {    const id = await createSessionWithAgent();
    const fileId = await uploadVideoFile('clip.mp4', Buffer.from('persisted'));

    const submitted = await submitVideoPrompt(id, [fileId]);
    await abortPrompt(id, submitted.data.prompt_id);

    await server!.close();
    server = undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    const { status, location } = await redirectOf('stub-llm-video-1');
    expect(status).toBe(302);
    expect(location).toBe(`/api/v1/files/${fileId}`);
  });
});
