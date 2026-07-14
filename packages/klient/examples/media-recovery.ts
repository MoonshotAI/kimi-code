/**
 * Example: end-to-end cases for the image format policy and the requester's
 * media recovery projections, driven against a REAL running kap-server over
 * `/api/v1` + `/api/v2` with `@moonshot-ai/klient` — no mocks.
 *
 * What is covered:
 *   A. REST ingestion gate — AVIF (declared AND sniffed through a lying
 *      label) and a remote `.avif` URL become text notices; a valid PNG
 *      passes through; a large WebP is re-encoded (not passed through).
 *   B. Core backstop — an AVIF data-URL injected straight through the v2
 *      prompt service (bypassing the REST gate) lands in the context
 *      history as a text notice, never as an image part.
 *   C. HTTP 413 recovery — with the `fault-injection` experimental flag, a
 *      one-shot `request-too-large` fault is armed; the turn still completes
 *      against the real provider via the media-degraded resend.
 *   D. Image-format recovery — same, with the `image-format` fault and the
 *      media-stripped resend.
 *
 * Prerequisites:
 *   - a kap-server started with the fault-injection flag and a real model:
 *       KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION=1 kimi server run --foreground
 *     (the master KIMI_CODE_EXPERIMENTAL_FLAG=1 also enables it)
 *   - the token is read from `<home>/server.token` (or `KIMI_SERVER_TOKEN`);
 *     omit both when the server runs with auth bypassed
 *   - the model comes from `KIMI_EXAMPLE_MODEL`, else `default_model` in
 *     `<home>/config.toml`; cases C/D run one tiny real turn each
 *
 * Run: `pnpm exec tsx examples/media-recovery.ts` (cwd = this package).
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { Klient, RPCError } from '@moonshot-ai/klient';
import { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import { IFaultInjectionService } from '@moonshot-ai/agent-core-v2/agent/faultInjection/faultInjection';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentPromptService } from '@moonshot-ai/agent-core-v2/agent/prompt/prompt';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
}

interface PromptItemWire {
  readonly prompt_id: string;
  readonly status: string;
  readonly content: unknown;
}

type WirePart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { kind: 'base64'; media_type: string; data: string } | { kind: 'url'; url: string } };

const home = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
const baseUrl = (process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627').replace(/\/$/, '');

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}

async function readToken(): Promise<string | undefined> {
  const fromEnv = process.env['KIMI_SERVER_TOKEN'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    const token = (await readFile(join(home, 'server.token'), 'utf8')).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined; // auth-bypassed dev server
  }
}

async function readDefaultModel(): Promise<string> {
  const fromEnv = process.env['KIMI_EXAMPLE_MODEL'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const config = await readFile(join(home, 'config.toml'), 'utf8');
  const match = /^default_model\s*=\s*"([^"]+)"/m.exec(config);
  if (match === null) throw new Error('default_model not found in config.toml; set KIMI_EXAMPLE_MODEL');
  return match[1]!;
}

function authHeaders(token: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  return token === undefined ? extra : { ...extra, authorization: `Bearer ${token}` };
}

async function postV1<T>(token: string | undefined, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as Envelope<T>;
  if (envelope.code !== 0) {
    throw new Error(`v1 ${path} failed: code=${envelope.code} msg=${envelope.msg}`);
  }
  return envelope.data;
}

// ── fixtures ─────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Minimal ftyp box sniffed as image/avif (bytes authoritative, no pixels). */
function avifFtyp(): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);
  buf.write('ftyp', 4, 'latin1');
  buf.write('avif', 8, 'latin1');
  buf.write('avif', 16, 'latin1');
  return buf;
}

/** Encode a solid 2100x1050 WebP (over the 2000px edge cap) via the wasm
 * encoder bundled with agent-core-v2's @jsquash/webp dependency. */
async function bigWebpBase64(): Promise<string> {
  const requireLocal = createRequire(import.meta.url);
  const requireFromV2 = createRequire(requireLocal.resolve('@moonshot-ai/agent-core-v2/package.json'));
  const { Jimp } = (await import(requireFromV2.resolve('jimp'))) as never as {
    Jimp: new (opts: { width: number; height: number; color: number }) => {
      bitmap: { data: Buffer; width: number; height: number };
    };
  };
  const encMod = (await import(
    requireFromV2.resolve('@jsquash/webp/encode.js')
  )) as { init(wasm: object): Promise<void>; default(data: unknown, opts: unknown): Promise<ArrayBuffer> };
  const wasmNamespace = (
    globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<object> } }
  ).WebAssembly;
  const wasm = await wasmNamespace.compile(
    await readFile(requireFromV2.resolve('@jsquash/webp/codec/enc/webp_enc.wasm')),
  );
  await encMod.init(wasm);
  const { bitmap } = new Jimp({ width: 2100, height: 1050, color: 0x3366ccff });
  const encoded = await encMod.default(
    {
      data: new Uint8ClampedArray(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.byteLength),
      width: bitmap.width,
      height: bitmap.height,
    },
    { quality: 90 },
  );
  return Buffer.from(encoded).toString('base64');
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = await readToken();
  const model = await readDefaultModel();
  console.log(`baseUrl = ${baseUrl}`);
  console.log(`model   = ${model}`);

  const client = new Klient(token === undefined ? { url: baseUrl } : { url: baseUrl, token });

  // Session A: REST ingestion gate (each submission also runs a background
  // turn against the real model — harmless).
  console.log('\n== A. REST ingestion gate ==');
  const sessionA = (await postV1<{ id: string }>(token, '/api/v1/sessions', {
    metadata: { cwd: await mkdtemp(join(tmpdir(), 'klient-media-a-')) },
  })).id;
  // Bind the model so the background turns can run.
  await client.session(sessionA).agent('main').service(IAgentProfileService).setModel(model);

  const submit = (content: unknown): Promise<PromptItemWire> =>
    postV1<PromptItemWire>(token, `/api/v1/sessions/${sessionA}/prompts`, { content });

  // A1: inline AVIF, honestly declared.
  const a1 = await submit([
    { type: 'image', source: { kind: 'base64', media_type: 'image/avif', data: avifFtyp().toString('base64') } },
  ]);
  const a1parts = a1.content as WirePart[];
  check(
    'A1 inline AVIF becomes a text notice',
    a1parts.length === 1 && a1parts[0]?.type === 'text' && a1parts[0].text.includes('image/avif'),
    JSON.stringify(a1parts).slice(0, 160),
  );

  // A2: AVIF bytes labeled image/png — the sniff wins over the label.
  const a2 = await submit([
    { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: avifFtyp().toString('base64') } },
  ]);
  const a2parts = a2.content as WirePart[];
  check(
    'A2 mislabeled AVIF bytes gated by sniff',
    a2parts.length === 1 && a2parts[0]?.type === 'text' && a2parts[0].text.includes('image/avif'),
    JSON.stringify(a2parts).slice(0, 160),
  );

  // A3: remote .avif URL — notice keeps the URL.
  const avifUrl = 'https://example.com/pic.avif';
  const a3 = await submit([{ type: 'image', source: { kind: 'url', url: avifUrl } }]);
  const a3parts = a3.content as WirePart[];
  check(
    'A3 remote .avif URL becomes a notice keeping the URL',
    a3parts.length === 1 &&
      a3parts[0]?.type === 'text' &&
      a3parts[0].text.includes('image/avif') &&
      a3parts[0].text.includes(avifUrl),
    JSON.stringify(a3parts).slice(0, 160),
  );

  // A4: large WebP is re-encoded (caption + non-WebP image), not passed through.
  const a4 = await submit([
    { type: 'image', source: { kind: 'base64', media_type: 'image/webp', data: await bigWebpBase64() } },
  ]);
  const a4parts = a4.content as WirePart[];
  const a4image = a4parts.find((p) => p.type === 'image');
  const a4caption = a4parts.find((p) => p.type === 'text' && p.text.includes('Image compressed'));
  check(
    'A4 large WebP re-encoded instead of passed through',
    a4image !== undefined &&
      a4image.type === 'image' &&
      a4image.source.kind === 'base64' &&
      a4image.source.media_type !== 'image/webp' &&
      a4caption !== undefined,
    JSON.stringify(a4parts.map((p) => (p.type === 'text' ? p.text.slice(0, 60) : p))).slice(0, 200),
  );

  // A5: small valid PNG passes through untouched.
  const a5 = await submit([
    { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: solidPng(32, 32, [0x33, 0x66, 0xcc]).toString('base64') } },
  ]);
  const a5parts = a5.content as WirePart[];
  check(
    'A5 valid PNG passes through as an image part',
    a5parts.length === 1 &&
      a5parts[0]?.type === 'image' &&
      a5parts[0].source.kind === 'base64' &&
      a5parts[0].source.media_type === 'image/png',
    JSON.stringify(a5parts).slice(0, 120),
  );

  // Session B: core backstop + recovery cases.
  const sessionB = (await postV1<{ id: string }>(token, '/api/v1/sessions', {
    metadata: { cwd: await mkdtemp(join(tmpdir(), 'klient-media-b-')) },
  })).id;
  const agentB = client.session(sessionB).agent('main');
  await agentB.service(IAgentProfileService).setModel(model);
  const prompt = agentB.service(IAgentPromptService);
  const context = agentB.service(IAgentContextMemoryService);

  console.log('\n== B. core backstop (v2 prompt funnel) ==');
  const backstopId = 'klient-backstop-avif';
  await prompt.enqueue({
    id: backstopId,
    message: {
      role: 'user',
      content: [
        {
          type: 'image_url',
          imageUrl: { url: `data:image/avif;base64,${avifFtyp().toString('base64')}` },
        },
      ],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  });
  // Wait for the message to materialize into the context, then abort the turn.
  let landed = false;
  for (let i = 0; i < 50; i++) {
    const messages = await Promise.resolve(context.get());
    const injected = messages.find((m) => m.role === 'user');
    if (injected !== undefined) {
      const hasAvifImage = injected.content.some(
        (p) => p.type === 'image_url' && p.imageUrl.url.includes('avif'),
      );
      const hasNotice = injected.content.some(
        (p) => p.type === 'text' && p.text.includes('image/avif'),
      );
      check(
        'B AVIF prompt lands in history as a text notice, never an image',
        !hasAvifImage && hasNotice,
        JSON.stringify(injected.content).slice(0, 160),
      );
      landed = true;
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  if (!landed) check('B AVIF prompt lands in history', false, 'message never materialized');
  await Promise.resolve(prompt.abort(backstopId));

  console.log('\n== C/D. recovery resends against the real provider ==');
  const fault = agentB.service(IFaultInjectionService);
  const profile = agentB.service(IAgentProfileService);
  const caps = await Promise.resolve(profile.data());
  const canSeeImages = caps.modelCapabilities.image_in;

  // Seed media into the history when the model can see images, so the
  // recovery projections are non-trivial (degraded keeps the recent two,
  // stripped removes all). Skip with a note on text-only models.
  if (canSeeImages) {
    const seedId = 'klient-seed-media';
    await prompt.enqueue({
      id: seedId,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'three seed images' },
          ...([0x3366cc, 0xcc6633, 0x66cc33] as const).map((color) => ({
            type: 'image_url' as const,
            imageUrl: {
              url: `data:image/png;base64,${solidPng(32, 32, [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]).toString('base64')}`,
            },
          })),
        ],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    for (let i = 0; i < 50; i++) {
      const messages = await Promise.resolve(context.get());
      if (messages.some((m) => m.content.some((p) => p.type === 'image_url'))) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    await Promise.resolve(prompt.abort(seedId));
    console.log('  seeded 3 PNG images into the history');
  } else {
    console.log('  note: model reports image_in=false — recovery runs on a text-only history');
  }

  const ws = client.ws();
  const agentEvents = ws.session(sessionB).agent('main');
  function waitCompleted(promptId: string, timeoutMs = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.dispose();
        reject(new Error(`timeout waiting for prompt.completed ${promptId}`));
      }, timeoutMs);
      const sub = agentEvents.listen('events', (event: unknown) => {
        const e = event as { type?: string; promptId?: string; reason?: string };
        if (e.type === 'prompt.completed' && e.promptId === promptId) {
          clearTimeout(timer);
          sub.dispose();
          resolve(e.reason ?? 'unknown');
        }
      });
    });
  }

  const runRecoverablePrompt = async (
    caseName: string,
    kind: 'request-too-large' | 'image-format',
    promptId: string,
  ): Promise<void> => {
    await Promise.resolve(fault.clear());
    await Promise.resolve(fault.arm(kind));
    const armed = (await Promise.resolve(fault.status())).armed;
    check(`${caseName} fault armed`, armed === kind);
    const completed = waitCompleted(promptId);
    await prompt.enqueue({
      id: promptId,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Reply with exactly: PONG' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    const reason = await completed;
    const fired = (await Promise.resolve(fault.status())).fired;
    check(
      `${caseName} turn completes via recovery resend`,
      reason === 'completed' && fired.length === 1 && fired[0] === kind,
      `reason=${reason} fired=${JSON.stringify(fired)}`,
    );
  };

  console.log('\n== C. HTTP 413 → media-degraded resend ==');
  await runRecoverablePrompt('C', 'request-too-large', 'klient-413');

  console.log('\n== D. image-format 400 → media-stripped resend ==');
  await runRecoverablePrompt('D', 'image-format', 'klient-imgfmt');

  ws.close();

  console.log('');
  if (failures.length > 0) {
    console.log(`FAILED: ${String(failures.length)} case(s): ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('ALL CASES PASSED');
  }
}

main().catch((error: unknown) => {
  if (error instanceof RPCError) {
    console.error(`\nFAILED (rpc): code=${String(error.code)} msg=${error.message}`);
    if (error.code === 40001 || /disabled/i.test(error.message)) {
      console.error(
        'hint: start the server with KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION=1 ' +
          '(or KIMI_CODE_EXPERIMENTAL_FLAG=1) for cases C/D',
      );
    }
  } else {
    console.error('\nFAILED:', error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
