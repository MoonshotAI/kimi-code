/**
 * Prompts end-to-end tests (W7.2 / Chain 4 / P1.4).
 *
 * **Bootstrap strategy**: spawn the real daemon (port 0, tmp lock + bridge
 * home) and exercise:
 *   1. POST /api/v1/sessions/{sid}/prompts validation (40001 on bad body, 40401
 *      on bad sid).
 *   2. Lifecycle event synthesis: register a fake active prompt directly on
 *      the IPromptService (so we don't have to drive agent-core through the
 *      bridge.rpc.prompt path, which requires provider creds). Publish
 *      `turn.started` → `assistant.delta` × N → `turn.ended` directly through
 *      the event bus. Verify a WS subscriber receives them all PLUS the
 *      synthesized `prompt.completed`.
 *
 * We don't drive a REAL prompt through agent-core in this test because:
 *   - prompt execution requires provider credentials + network IO.
 *   - the architecture under test is the daemon's event-service synthesis +
 *     fan-out path, not the model's behavior.
 *   - the services-layer unit tests at
 *     `packages/services/test/prompt-service.test.ts` exercise the protocol
 *     → kosong content adapter against a mocked bridge.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { Event, PromptSubmission } from '@moonshot-ai/protocol';
import { IEventService, IPromptService, PromptService } from '@moonshot-ai/services';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-prompts-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-prompts-home-'));
});

afterEach(async () => {
  try {
    await daemon?.close();
  } catch {
    // ignore
  }
  daemon = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningDaemon> {
  daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    wsGatewayOptions: { pingIntervalMs: 5_000, pongTimeoutMs: 5_000 },
  });
  return daemon;
}

function appOf(r: RunningDaemon): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

function overridePromptService(
  r: RunningDaemon,
  stub: Partial<IPromptService>,
): void {
  const noopComplete = (() => ({ dispose: () => undefined })) as IPromptService['onDidComplete'];
  const noopAbort = (() => ({ dispose: () => undefined })) as IPromptService['onDidAbort'];
  const defaultImpl: IPromptService = {
    _serviceBrand: undefined,
    submit: async () => ({
      prompt_id: 'prompt_test',
      user_message_id: 'msg_test',
    }),
    abort: async () => ({ aborted: true }),
    applyAgentState: async () => undefined,
    onDidComplete: noopComplete,
    onDidAbort: noopAbort,
  };
  const replacement = { ...defaultImpl, ...stub };
  const ix = r.services as unknown as {
    services: { set: (id: unknown, impl: unknown) => void };
    _instances: Map<unknown, unknown>;
  };
  ix.services.set(IPromptService, replacement);
  ix._instances.set(IPromptService, replacement);
}

function buildMultipart(parts: {
  file: { fieldName: string; filename: string; contentType: string; data: Buffer };
  fields?: Array<{ name: string; value: string }>;
}): { body: Buffer; contentType: string } {
  const boundary = '------WebKitFormBoundaryKimiDaemonPromptTest';
  const lines: Array<Buffer | string> = [];
  if (parts.fields) {
    for (const field of parts.fields) {
      lines.push(`--${boundary}\r\n`);
      lines.push(
        `Content-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
      );
    }
  }
  lines.push(`--${boundary}\r\n`);
  lines.push(
    `Content-Disposition: form-data; name="${parts.file.fieldName}"; filename="${parts.file.filename}"\r\n`,
  );
  lines.push(`Content-Type: ${parts.file.contentType}\r\n\r\n`);
  lines.push(parts.file.data);
  lines.push(`\r\n--${boundary}--\r\n`);

  return {
    body: Buffer.concat(
      lines.map((line) => (typeof line === 'string' ? Buffer.from(line, 'utf8') : line)),
    ),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function wsDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return JSON.stringify(data);
}

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

async function createSession(r: RunningDaemon): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: join(tmpDir, 'workspace') } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

/**
 * Open a WS subscriber and wait for server_hello + client_hello ack.
 * Returns a handle exposing the received frame queue.
 *
 * Mirrors the queueing pattern from `ws-broadcast.e2e.test.ts` — message
 * listener is attached BEFORE the `open` event resolves, so frames that land
 * in the same tick as the upgrade aren't lost.
 */
async function openSubscriber(
  r: RunningDaemon,
  sid: string,
): Promise<{
  ws: WebSocket;
  received: Record<string, unknown>[];
}> {
  const wsUrl = r.address.replace('http://', 'ws://') + '/api/v1/ws';
  const received: Record<string, unknown>[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    sock.on('message', (data) => {
      try {
        received.push(JSON.parse(wsDataToString(data)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });
    sock.once('open', () => resolve(sock));
    sock.once('error', reject);
  });
  // Wait for server_hello.
  await waitFor(received, (f) => f['type'] === 'server_hello');
  ws.send(
    JSON.stringify({
      type: 'client_hello',
      id: 'h1',
      payload: { client_id: 'test', subscriptions: [sid] },
    }),
  );
  await waitFor(received, (f) => f['type'] === 'ack' && f['id'] === 'h1');
  return { ws, received };
}

async function waitFor(
  received: Record<string, unknown>[],
  pred: (f: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = received.find(pred);
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `waitFor timed out; received: ${received.map((f) => f['type']).join(', ')}`,
  );
}

describe('POST /api/v1/sessions/{sid}/prompts — submit validation (W7.2 / Chain 4)', () => {
  it('rejects an empty content array with 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: { content: [] },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(env.data).toBeNull();
    expect(Array.isArray(env.details)).toBe(true);
  });

  it('returns 40401 for an unknown session id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing/prompts',
      payload: {
        content: [{ type: 'text', text: 'hello' }],
        model: 'x',
        thinking: 'off',
        permission_mode: 'manual',
        plan_mode: false,
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });

  it('rejects bad content shape with 40001 (no `type` field)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: { content: [{ text: 'no type' }] },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });

  it('submits image URL content without a file upload step', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    let submittedSid: string | undefined;
    let submitted: PromptSubmission | undefined;
    overridePromptService(r, {
      submit: async (sessionId, body) => {
        submittedSid = sessionId;
        submitted = body;
        return {
          prompt_id: 'prompt_from_stub',
          user_message_id: 'msg_from_stub',
        };
      },
    });

    const imageUrl = 'https://example.com/images/sample.png?size=full#frame';
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          { type: 'text', text: 'describe this image' },
          {
            type: 'image',
            source: { kind: 'url', url: imageUrl },
          },
        ],
      },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(0);
    expect(submittedSid).toBe(sid);
    expect(submitted?.content).toEqual([
      { type: 'text', text: 'describe this image' },
      {
        type: 'image',
        source: { kind: 'url', url: imageUrl },
      },
    ]);
  });

  it('uploads a real PNG image file and resolves it before submitting the prompt', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    let submitted: PromptSubmission | undefined;
    overridePromptService(r, {
      submit: async (_sid, body) => {
        submitted = body;
        return {
          prompt_id: 'prompt_from_stub',
          user_message_id: 'msg_from_stub',
        };
      },
    });

    const upload = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'tiny.png',
        contentType: 'image/png',
        data: ONE_BY_ONE_PNG,
      },
    });
    const uploadRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: upload.body,
      headers: { 'content-type': upload.contentType },
    });
    const uploadEnv = envelopeOf<{ id: string; media_type: string; size: number }>(
      uploadRes.json(),
    );
    expect(uploadEnv.code).toBe(0);
    expect(uploadEnv.data).not.toBeNull();
    expect(uploadEnv.data?.media_type).toBe('image/png');
    expect(uploadEnv.data?.size).toBe(ONE_BY_ONE_PNG.length);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          { type: 'text', text: 'what is this?' },
          {
            type: 'image',
            source: { kind: 'file', file_id: uploadEnv.data!.id },
          },
        ],
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    expect(submitted?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      {
        type: 'image',
        source: {
          kind: 'base64',
          media_type: 'image/png',
          data: ONE_BY_ONE_PNG.toString('base64'),
        },
      },
    ]);
  });

  it('returns 40407 when prompt image file_id is unknown', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    let submitted = false;
    overridePromptService(r, {
      submit: async () => {
        submitted = true;
        return {
          prompt_id: 'prompt_from_stub',
          user_message_id: 'msg_from_stub',
        };
      },
    });

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          {
            type: 'image',
            source: { kind: 'file', file_id: 'f_missing' },
          },
        ],
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40407);
    expect(submitted).toBe(false);
  });

  it('rejects non-image file_id content before submitting the prompt', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    let submitted = false;
    overridePromptService(r, {
      submit: async () => {
        submitted = true;
        return {
          prompt_id: 'prompt_from_stub',
          user_message_id: 'msg_from_stub',
        };
      },
    });

    const upload = buildMultipart({
      file: {
        fieldName: 'file',
        filename: 'note.txt',
        contentType: 'text/plain',
        data: Buffer.from('not an image'),
      },
    });
    const uploadRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: upload.body,
      headers: { 'content-type': upload.contentType },
    });
    const uploadEnv = envelopeOf<{ id: string }>(uploadRes.json());
    expect(uploadEnv.code).toBe(0);
    expect(uploadEnv.data).not.toBeNull();

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [
          {
            type: 'image',
            source: { kind: 'file', file_id: uploadEnv.data!.id },
          },
        ],
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(submitted).toBe(false);
  });
});

describe('Prompt lifecycle: WS receives events + synthesized prompt.completed (W7.2)', () => {
  it('synthesizes prompt.completed end-to-end through bus → observer → WS', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const promptId = `prompt_TEST_${sid}`;
    const turnId = 42;

    // Inject an active-prompt record into the daemon's IPromptService so the
    // lifecycle observer recognizes turn.* events for this session. We skip
    // a real `bridge.rpc.prompt(...)` call because it would require provider
    // credentials + a fully-loaded agent.
    const impl = r.services.invokeFunction(
      (a) => a.get(IPromptService) as PromptService,
    );
    expect(impl).toBeInstanceOf(PromptService);
    impl._injectActiveForTest(sid, promptId, null);

    // Publish the agent-core event stream directly through the bus.
    const eventBus = r.services.invokeFunction((a) => a.get(IEventService));
    eventBus.publish({
      type: 'turn.started',
      turnId,
      origin: { kind: 'user' },
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'assistant.delta',
      turnId,
      delta: 'hi ',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'assistant.delta',
      turnId,
      delta: 'there',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'turn.ended',
      turnId,
      reason: 'completed',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);

    // Wait for the synthesized prompt.completed event on the WS.
    const promptCompletedFrame = await waitFor(
      received,
      (f) => f['type'] === 'prompt.completed',
      2000,
    );
    const payload = promptCompletedFrame['payload'] as {
      promptId: string;
      reason: string;
    };
    expect(payload.promptId).toBe(promptId);
    expect(payload.reason).toBe('completed');
    expect(promptCompletedFrame['session_id']).toBe(sid);

    // Verify the upstream events also arrived in order.
    const types = received.map((f) => f['type']);
    expect(types).toContain('turn.started');
    expect(types).toContain('assistant.delta');
    expect(types).toContain('turn.ended');
    expect(types).toContain('prompt.completed');
    // prompt.completed lands AFTER turn.ended (synthesized post-fan-out).
    const turnEndedIdx = types.lastIndexOf('turn.ended');
    const completedIdx = types.lastIndexOf('prompt.completed');
    expect(completedIdx).toBeGreaterThan(turnEndedIdx);

    ws.close();
  });

  it('synthesizes prompt.aborted when turn.ended (reason=cancelled) fires', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const promptId = `prompt_ABORT_TEST_${sid}`;
    const turnId = 7;

    const impl = r.services.invokeFunction(
      (a) => a.get(IPromptService) as PromptService,
    );
    impl._injectActiveForTest(sid, promptId, null);

    const eventBus = r.services.invokeFunction((a) => a.get(IEventService));
    eventBus.publish({
      type: 'turn.started',
      turnId,
      origin: { kind: 'user' },
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'turn.ended',
      turnId,
      reason: 'cancelled',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);

    const abortedFrame = await waitFor(
      received,
      (f) => f['type'] === 'prompt.aborted',
      2000,
    );
    const payload = abortedFrame['payload'] as { promptId: string };
    expect(payload.promptId).toBe(promptId);

    ws.close();
  });
});
