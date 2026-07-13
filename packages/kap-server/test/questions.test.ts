import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ISessionQuestionService,
  ISessionLifecycleService,
  type QuestionRequest,
  type QuestionResult,
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

interface QuestionOptionWire {
  id: string;
  label: string;
  description?: string;
}

interface QuestionItemWire {
  id: string;
  question: string;
  header?: string;
  body?: string;
  options: QuestionOptionWire[];
  multi_select?: boolean;
  allow_other?: boolean;
  other_label?: string;
  other_description?: string;
}

interface QuestionWire {
  question_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id?: string;
  questions: QuestionItemWire[];
  created_at: string;
}

interface ListWire {
  items: QuestionWire[];
}

interface ResolveWire {
  resolved: true;
  resolved_at: string;
}

interface DismissWire {
  dismissed: true;
  dismissed_at: string;
}

describe('server-v2 /api/v1/sessions/{sid}/questions', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-questions-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  function questionService(sessionId: string): ISessionQuestionService {
    const handle = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    expect(handle).toBeDefined();
    return handle!.accessor.get(ISessionQuestionService);
  }

  function makeRequest(id: string): QuestionRequest {
    return {
      id,
      toolCallId: `tc-${id}`,
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'Yes' }, { label: 'No', description: 'decline' }],
        },
      ],
    };
  }

  it('lists a pending question projected onto the wire shape', async () => {
    const sid = await createSession();
    questionService(sid).enqueue(makeRequest('q-1'));

    const { body } = await getJson<ListWire>(`/api/v1/sessions/${sid}/questions?status=pending`);
    expect(body.code).toBe(0);
    expect(body.data.items).toHaveLength(1);
    const item = body.data.items[0]!;
    expect(item.question_id).toBe('q-1');
    expect(item.session_id).toBe(sid);
    expect(item.tool_call_id).toBe('tc-q-1');
    expect(item.questions).toEqual([
      {
        id: 'q_0',
        question: 'Pick one',
        options: [
          { id: 'opt_0_0', label: 'Yes' },
          { id: 'opt_0_1', label: 'No', description: 'decline' },
        ],
        allow_other: true,
      },
    ]);
    expect(Number.isNaN(Date.parse(item.created_at))).toBe(false);
    // v1 parity: the question wire shape carries no synthetic expiry.
    expect(item).not.toHaveProperty('expires_at');
  });

  it('resolves a pending question', async () => {
    const sid = await createSession();
    questionService(sid).enqueue(makeRequest('q-2'));

    const { body } = await postJson<ResolveWire>(`/api/v1/sessions/${sid}/questions/q-2`, {
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
      method: 'number_key',
    });
    expect(body.code).toBe(0);
    expect(body.data.resolved).toBe(true);
    expect(Number.isNaN(Date.parse(body.data.resolved_at))).toBe(false);

    const listed = await getJson<ListWire>(`/api/v1/sessions/${sid}/questions?status=pending`);
    expect(listed.body.data.items).toHaveLength(0);
  });

  it('flattens the protocol response into the in-process result', async () => {
    const sid = await createSession();
    const resultPromise: Promise<QuestionResult> = questionService(sid).request(makeRequest('q-3'));

    await postJson<ResolveWire>(`/api/v1/sessions/${sid}/questions/q-3`, {
      answers: {
        q_0: { kind: 'multi', option_ids: ['opt_0_0', 'opt_0_1'] },
      },
      method: 'click', // protocol-only method; dropped on the in-process side
    });

    // Wire ids are translated back to question text / option labels so the
    // record the model sees is self-explanatory (v1 parity: multi joins with
    // ', ' to match the TUI reverse-RPC path).
    await expect(resultPromise).resolves.toEqual({
      answers: { 'Pick one': 'Yes, No' },
    });
  });

  function makeTwoQuestionRequest(id: string): QuestionRequest {
    return {
      id,
      toolCallId: `tc-${id}`,
      questions: [
        {
          question: 'Which animal?',
          options: [{ label: 'Cat' }, { label: 'Dog' }],
        },
        {
          question: 'Which colors?',
          options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
          multiSelect: true,
        },
      ],
    };
  }

  it('translates ids to text across single / other / multi_with_other kinds', async () => {
    const sid = await createSession();
    const single: Promise<QuestionResult> = questionService(sid).request(
      makeTwoQuestionRequest('q-t1'),
    );
    await postJson<ResolveWire>(`/api/v1/sessions/${sid}/questions/q-t1`, {
      answers: {
        q_0: { kind: 'single', option_id: 'opt_0_1' },
        q_1: {
          kind: 'multi_with_other',
          option_ids: ['opt_1_0', 'opt_1_1'],
          other_text: 'Custom',
        },
      },
    });
    await expect(single).resolves.toEqual({
      answers: { 'Which animal?': 'Dog', 'Which colors?': 'Red, Green, Custom' },
    });

    const other: Promise<QuestionResult> = questionService(sid).request(
      makeTwoQuestionRequest('q-t2'),
    );
    await postJson<ResolveWire>(`/api/v1/sessions/${sid}/questions/q-t2`, {
      answers: {
        q_0: { kind: 'other', text: 'Hippopotamus' },
        q_1: { kind: 'skipped' },
      },
    });
    await expect(other).resolves.toEqual({
      answers: { 'Which animal?': 'Hippopotamus' },
    });
  });

  it('keeps unknown and cross-question option ids verbatim (stale client)', async () => {
    const sid = await createSession();
    const resultPromise: Promise<QuestionResult> = questionService(sid).request(
      makeTwoQuestionRequest('q-t3'),
    );

    await postJson<ResolveWire>(`/api/v1/sessions/${sid}/questions/q-t3`, {
      answers: {
        // opt_0_9 does not exist; q_9 is an unknown question id.
        q_0: { kind: 'single', option_id: 'opt_0_9' },
        q_9: { kind: 'single', option_id: 'opt_9_0' },
        // opt_0_0 belongs to question 0 — never offered for question 1, so it
        // must NOT be resolved to 'Cat'.
        q_1: { kind: 'multi', option_ids: ['opt_1_0', 'opt_0_0'] },
      },
    });

    await expect(resultPromise).resolves.toEqual({
      answers: {
        'Which animal?': 'opt_0_9',
        q_9: 'opt_9_0',
        'Which colors?': 'Red, opt_0_0',
      },
    });
  });

  it('produces an empty answers record when all questions are skipped (not a dismissal)', async () => {
    const sid = await createSession();
    const resultPromise: Promise<QuestionResult> = questionService(sid).request(
      makeTwoQuestionRequest('q-t4'),
    );

    await postJson<ResolveWire>(`/api/v1/sessions/${sid}/questions/q-t4`, {
      answers: {
        q_0: { kind: 'skipped' },
        q_1: { kind: 'skipped' },
      },
    });

    await expect(resultPromise).resolves.toEqual({ answers: {} });
  });

  it('dismisses a pending question', async () => {
    const sid = await createSession();
    const resultPromise: Promise<QuestionResult> = questionService(sid).request(makeRequest('q-4'));

    const { body } = await postJson<DismissWire>(
      `/api/v1/sessions/${sid}/questions/q-4:dismiss`,
    );
    expect(body.code).toBe(40909);
    expect(body.data.dismissed).toBe(true);
    expect(Number.isNaN(Date.parse(body.data.dismissed_at))).toBe(false);

    await expect(resultPromise).resolves.toBeNull();
    const listed = await getJson<ListWire>(`/api/v1/sessions/${sid}/questions?status=pending`);
    expect(listed.body.data.items).toHaveLength(0);
  });

  it('returns 40902 on a duplicate resolve (recently-resolved window)', async () => {
    const sid = await createSession();
    questionService(sid).enqueue(makeRequest('q-5'));
    await postJson<ResolveWire>(`/api/v1/sessions/${sid}/questions/q-5`, {
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
    });

    const dup = await postJson<{ resolved: false }>(`/api/v1/sessions/${sid}/questions/q-5`, {
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
    });
    expect(dup.body.code).toBe(40902);
    expect(dup.body.data).toEqual({ resolved: false });
  });

  it('returns 40405 for an unknown question id', async () => {
    const sid = await createSession();
    const { body } = await postJson<null>(`/api/v1/sessions/${sid}/questions/nope`, {
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
    });
    expect(body.code).toBe(40405);
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/nope/questions?status=pending');
    expect(body.code).toBe(40401);
  });
});
