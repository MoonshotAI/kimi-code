/**
 * Question end-to-end tests (W8.2 / Chain 6 / P1.6).
 *
 * Covers the reverse-RPC path: agent-core → BridgeClientAPI.requestQuestion →
 * IQuestionService.request → WS `event.question.requested` → REST
 * `POST /api/v1/sessions/{sid}/questions/{qid}` (or `:dismiss`) → Promise
 * resolves with `Record<string, string | true>` (or `null` for dismiss).
 *
 * Mirrors `approval.e2e.test.ts` strategy — bypass `bridge.rpc.prompt(...)`
 * (no provider creds) and drive the broker directly via DI accessor.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  IQuestionService,
  type QuestionRequest,
  type QuestionResult,
} from '@moonshot-ai/agent-core';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';
import { rawDataToString } from '../src/ws/rawData';
import { QuestionService } from '#/services/question/questionService';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

function rmSyncRobust(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw error;
    // Best-effort cleanup: a child process may still hold the cwd or be
    // writing into the dir after server.close(); the OS reclaims the temp dir
    // later and a cleanup hiccup must not fail an otherwise-passing test.
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-questions-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-questions-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSyncRobust(tmpDir);
  rmSyncRobust(bridgeHome);
});

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    wsGatewayOptions: { pingIntervalMs: 5_000, pongTimeoutMs: 5_000 },
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
};
  });
  // Auto-attach the fixed bearer token so the M5.1 auth hook passes. A
  // caller-supplied `authorization` header wins, so explicit token tests keep
  // working; every other header (Range, content-type, …) is preserved.
  return {
    inject(req: unknown) {
      const q = req as { headers?: Record<string, string | string[] | undefined> };
      return app.inject({
        ...q,
        headers: { authorization: 'Bearer test-token', ...q.headers },
      });
    },
  };
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

async function createSession(r: RunningServer): Promise<string> {
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

async function openSubscriber(
  r: RunningServer,
  sid: string,
): Promise<{
  ws: WebSocket;
  received: Record<string, unknown>[];
}> {
  const wsUrl = r.address.replace('http://', 'ws://') + '/api/v1/ws';
  const received: Record<string, unknown>[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(wsUrl, ['kimi-code.bearer.test-token']);
    sock.on('message', (data) => {
      try {
        received.push(JSON.parse(rawDataToString(data)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });
    sock.once('open', () => resolve(sock));
    sock.once('error', reject);
  });
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

function firstPendingQuestionId(broker: QuestionService): string | undefined {
  return (broker as unknown as {
    _pending: Map<string, { questionId: string }>;
  })._pending.values().next().value?.questionId;
}

// --- Tests -----------------------------------------------------------------

describe('Question reverse-RPC: WS broadcast → REST resolve → Promise settle (W8.2)', () => {
  it('full happy path: 4-item question → POST 4 answers (incl. 1 skipped) → agent receives normalized record', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const broker = r.services.invokeFunction(
      (a) => a.get(IQuestionService) as QuestionService,
    );

    const inProcReq: QuestionRequest = {
      turnId: 1,
      toolCallId: 'tc_q',
      questions: [
        {
          question: 'Animal?',
          options: [{ label: 'Cat' }, { label: 'Dog' }],
        },
        {
          question: 'Colors?',
          options: [{ label: 'R' }, { label: 'G' }, { label: 'B' }],
          multiSelect: true,
        },
        {
          question: 'Custom?',
          options: [{ label: 'X' }],
          otherLabel: 'Other',
        },
        {
          question: 'Skip me',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    };

    const pending = broker.request({
      ...inProcReq,
      sessionId: sid,
      agentId: 'main',
    });

    const requested = await waitFor(
      received,
      (f) => f['type'] === 'event.question.requested',
      2000,
    );
    const payload = requested['payload'] as {
      question_id: string;
      session_id: string;
      questions: Array<{ id: string; question: string; options: Array<{ id: string; label: string }> }>;
    };
    expect(payload.question_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(payload.session_id).toBe(sid);
    expect(payload.questions).toHaveLength(4);
    expect(payload.questions[0]?.id).toBe('q_0');
    expect(payload.questions[0]?.options[0]?.id).toBe('opt_0_0');
    expect(payload.questions[2]?.options[0]?.id).toBe('opt_2_0');

    // POST with mixed kinds INCLUDING one skipped.
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/questions/${payload.question_id}`,
      payload: {
        answers: {
          q_0: { kind: 'single', option_id: 'opt_0_0' },
          q_1: { kind: 'multi', option_ids: ['opt_1_0', 'opt_1_2'] },
          q_2: { kind: 'other', text: 'Hippopotamus' },
          q_3: { kind: 'skipped' },
        },
        method: 'enter',
      },
    });
    const env = envelopeOf<{ resolved: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.resolved).toBe(true);

    // Promise resolves with the SCHEMAS §6.4 flattened shape.
    const result = await pending;
    expect(result).not.toBeNull();
    const inProcResp = result as {
      answers: Record<string, string | true>;
      method?: string;
    };
    expect(inProcResp.answers).toEqual({
      q_0: 'opt_0_0',
      q_1: 'opt_1_0,opt_1_2',
      q_2: 'Hippopotamus',
      // q_3 omitted entirely (kind: skipped)
    });
    expect(inProcResp.method).toBe('enter');

    ws.close();
  });

  it('GET pending questions lists recoverable requests and omits dismissed ones', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    const broker = r.services.invokeFunction(
      (a) => a.get(IQuestionService) as QuestionService,
    );
    const pending = broker.request({
      sessionId: sid,
      agentId: 'main',
      turnId: 2,
      toolCallId: 'tc_question_recovery',
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          otherLabel: 'Other',
        },
      ],
    });

    let questionId: string | undefined;
    try {
      const res = await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/sessions/${sid}/questions?status=pending`,
      });
      const env = envelopeOf<{
        items: Array<{
          question_id: string;
          session_id: string;
          turn_id?: number;
          tool_call_id?: string;
          questions: Array<{
            id: string;
            question: string;
            options: Array<{ id: string; label: string }>;
            allow_other?: boolean;
            other_label?: string;
          }>;
          created_at: string;
        }>;
      }>(res.json());
      expect(env.code).toBe(0);
      expect(env.data?.items).toHaveLength(1);

      const item = env.data?.items[0];
      expect(item).toBeDefined();
      questionId = item?.question_id;
      expect(item?.session_id).toBe(sid);
      expect(item?.turn_id).toBe(2);
      expect(item?.tool_call_id).toBe('tc_question_recovery');
      expect(item?.questions[0]).toMatchObject({
        id: 'q_0',
        question: 'Continue?',
        allow_other: true,
        other_label: 'Other',
      });
      expect(item?.questions[0]?.options).toEqual([
        { id: 'opt_0_0', label: 'Yes' },
        { id: 'opt_0_1', label: 'No' },
      ]);
      expect(item?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const dismissed = await appOf(r).inject({
        method: 'POST',
        url: `/api/v1/sessions/${sid}/questions/${questionId}:dismiss`,
        payload: {},
      });
      expect(envelopeOf<{ dismissed: boolean }>(dismissed.json()).code).toBe(40909);
      await pending;

      const after = await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/sessions/${sid}/questions?status=pending`,
      });
      const afterEnv = envelopeOf<{ items: unknown[] }>(after.json());
      expect(afterEnv.code).toBe(0);
      expect(afterEnv.data?.items).toEqual([]);
    } finally {
      const cleanupId = questionId ?? firstPendingQuestionId(broker);
      if (cleanupId !== undefined && broker.isPending(cleanupId)) {
        broker.dismiss(cleanupId);
      }
      await pending.catch(() => undefined);
    }
  });

  it('GET pending questions rejects unsupported status', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/questions?status=answered`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });

  it.each([
    [
      'single kind',
      [{ question: '?', options: [{ label: 'A' }, { label: 'B' }] }],
      { q_0: { kind: 'single', option_id: 'opt_0_1' } },
      { q_0: 'opt_0_1' },
    ],
    [
      'multi kind',
      [{ question: '?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true }],
      { q_0: { kind: 'multi', option_ids: ['opt_0_0', 'opt_0_2'] } },
      { q_0: 'opt_0_0,opt_0_2' },
    ],
    [
      'other kind',
      [{ question: '?', options: [{ label: 'X' }, { label: 'Y' }], otherLabel: 'Other' }],
      { q_0: { kind: 'other', text: 'free' } },
      { q_0: 'free' },
    ],
    [
      'multi_with_other kind',
      [{ question: '?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true, otherLabel: 'Other' }],
      {
        q_0: {
          kind: 'multi_with_other',
          option_ids: ['opt_0_0'],
          other_text: 'X',
        },
      },
      { q_0: 'opt_0_0,X' },
    ],
    [
      'skipped kind (record entry omitted)',
      [{ question: '?', options: [{ label: 'A' }, { label: 'B' }] }],
      { q_0: { kind: 'skipped' } },
      {},
    ],
  ] as const)(
    'normalizes %s per SCHEMAS §6.4',
    async (_label, questions, answers, expectedRecord) => {
      const r = await bootDaemon();
      const sid = await createSession(r);

      const broker = r.services.invokeFunction(
        (a) => a.get(IQuestionService) as QuestionService,
      );
      const pending = broker.request({
        sessionId: sid,
        agentId: 'main',
        toolCallId: 'tc_kind',
        questions: questions as unknown as QuestionRequest['questions'],
      });

      // Pull the server-minted question_id by peeking at the pending map.
      let questionId: string | undefined;
      for (let i = 0; i < 20 && !questionId; i++) {
        await new Promise((r) => setTimeout(r, 10));
        questionId = (broker as unknown as {
          _pending: Map<string, { questionId: string }>;
        })._pending.values().next().value?.questionId;
      }
      expect(questionId).toBeDefined();

      const res = await appOf(r).inject({
        method: 'POST',
        url: `/api/v1/sessions/${sid}/questions/${questionId}`,
        payload: { answers },
      });
      const env = envelopeOf<{ resolved: boolean }>(res.json());
      expect(env.code).toBe(0);

      const result = await pending;
      const inProcResp = result as { answers: Record<string, string | true> };
      expect(inProcResp.answers).toEqual(expectedRecord);
    },
  );

  it('dismiss path: POST :dismiss → WS event.question.dismissed → Promise resolves with null', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const broker = r.services.invokeFunction(
      (a) => a.get(IQuestionService) as QuestionService,
    );
    const pending = broker.request({
      sessionId: sid,
      agentId: 'main',
      questions: [
        {
          question: 'Skip me?',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    });

    const requested = await waitFor(
      received,
      (f) => f['type'] === 'event.question.requested',
      2000,
    );
    const payload = requested['payload'] as { question_id: string };

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/questions/${payload.question_id}:dismiss`,
      payload: {},
    });
    const env = envelopeOf<{ dismissed: boolean; dismissed_at: string }>(res.json());
    expect(env.code).toBe(40909);
    expect(env.data?.dismissed).toBe(true);
    expect(env.data?.dismissed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const dismissedFrame = await waitFor(
      received,
      (f) => f['type'] === 'event.question.dismissed',
      2000,
    );
    const dPayload = dismissedFrame['payload'] as { question_id: string };
    expect(dPayload.question_id).toBe(payload.question_id);

    const result: QuestionResult = await pending;
    expect(result).toBeNull();

    ws.close();
  });

  it('aborts the pending question when the request signal aborts', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const broker = r.services.invokeFunction(
      (a) => a.get(IQuestionService) as QuestionService,
    );

    const controller = new AbortController();
    const pending = broker.request(
      {
        sessionId: sid,
        agentId: 'main',
        questions: [{ question: '?', options: [{ label: 'A' }, { label: 'B' }] }],
      },
      { signal: controller.signal },
    );

    const requested = await waitFor(
      received,
      (f) => f['type'] === 'event.question.requested',
      2000,
    );
    const payload = requested['payload'] as { question_id: string };

    // Simulate the turn being aborted before the user answers.
    controller.abort();

    const dismissedFrame = await waitFor(
      received,
      (f) => f['type'] === 'event.question.dismissed',
      2000,
    );
    const dPayload = dismissedFrame['payload'] as { question_id: string };
    expect(dPayload.question_id).toBe(payload.question_id);

    // Broker entry is cleaned up so listPending/session status don't stick.
    expect(broker.isPending(payload.question_id)).toBe(false);

    const result: QuestionResult = await pending;
    expect(result).toBeNull();

    ws.close();
  });

  it('REST resolve on unknown question_id returns 40405', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/questions/01JAAAAAAAAAAAAAAAAAAAAAAA`,
      payload: { answers: { q_0: { kind: 'skipped' } } },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40405);
  });

  it('REST :dismiss on unknown question_id returns 40405', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/questions/01JBBBBBBBBBBBBBBBBBBBBBBB:dismiss`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40405);
  });

  it('REST re-resolve on already-resolved question returns 40902 with data:{resolved:false}', async () => {


    const r = await bootDaemon();
    const sid = await createSession(r);

    const broker = r.services.invokeFunction(
      (a) => a.get(IQuestionService) as QuestionService,
    );
    const pending = broker.request({
      sessionId: sid,
      agentId: 'main',
      questions: [
        { question: '?', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    });

    let questionId: string | undefined;
    for (let i = 0; i < 20 && !questionId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      questionId = (broker as unknown as {
        _pending: Map<string, { questionId: string }>;
      })._pending.values().next().value?.questionId;
    }
    expect(questionId).toBeDefined();

    const ok = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/questions/${questionId}`,
      payload: { answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } },
    });
    expect(envelopeOf<{ resolved: boolean }>(ok.json()).code).toBe(0);
    await pending;

    const dup = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/questions/${questionId}`,
      payload: { answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } },
    });
    const dupEnv = envelopeOf<{ resolved: boolean }>(dup.json());
    expect(dupEnv.code).toBe(40902);
    expect(dupEnv.data).toEqual({ resolved: false });
  });

  it('REST resolve with bad body (unknown kind) returns 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    const broker = r.services.invokeFunction(
      (a) => a.get(IQuestionService) as QuestionService,
    );
    const _pending = broker.request({
      sessionId: sid,
      agentId: 'main',
      questions: [
        { question: '?', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    });
    void _pending;

    let questionId: string | undefined;
    for (let i = 0; i < 20 && !questionId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      questionId = (broker as unknown as {
        _pending: Map<string, { questionId: string }>;
      })._pending.values().next().value?.questionId;
    }

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/questions/${questionId}`,
      payload: { answers: { q_0: { kind: 'rangefinder', value: 42 } } },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);

    // Cleanup so the test doesn't leave a hanging Promise.
    broker.dismiss(questionId!);
  });
});
