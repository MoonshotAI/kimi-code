import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { randomUUID } from 'node:crypto';

import {
  ensureMainAgent,
  getLiveSessionById,
  interactions,
  type InteractionTags,
  type QuestionRequest,
  type QuestionResult,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface RespondWire {
  outcome: string;
  ended_at: string;
}

describe('server-v2 /api/v1/sessions/{sid}/interactions (question)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-questions-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  async function createSession(): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    expect(body.code).toBe(0);
    const handle = getLiveSessionById(server!.core.accessor, body.data.id);
    expect(handle).toBeDefined();
    await ensureMainAgent(handle!);
    return body.data.id;
  }

  function questionTags(sessionId: string, req: QuestionRequest): InteractionTags {
    const tags: InteractionTags = { agentId: 'main', sessionId };
    if (req.turnId !== undefined) tags['turnId'] = req.turnId;
    if (req.toolCallId !== undefined) tags['toolCallId'] = req.toolCallId;
    return tags;
  }

  function enqueueQuestion(sessionId: string, req: QuestionRequest): void {
    interactions.enqueue({
      id: req.id ?? `question_${randomUUID()}`,
      kind: 'question',
      payload: req,
      tags: questionTags(sessionId, req),
    });
  }

  function requestQuestion(sessionId: string, req: QuestionRequest): Promise<QuestionResult> {
    const parked = interactions.enqueue({
      id: req.id ?? `question_${randomUUID()}`,
      kind: 'question',
      payload: req,
      tags: questionTags(sessionId, req),
    });
    return interactions.wait<QuestionResult>(parked.id);
  }

  function pendingQuestions(sessionId: string) {
    return interactions.findAll({ kind: 'question', resolved: false, tags: { sessionId } });
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

  it('resolves a pending question', async () => {
    const sid = await createSession();
    enqueueQuestion(sid, makeRequest('q-2'));

    const { body } = await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/q-2`, {
      kind: 'question',
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
      method: 'number_key',
    });
    expect(body.code).toBe(0);
    expect(body.data.outcome).toBe('answered');
    expect(Number.isNaN(Date.parse(body.data.ended_at))).toBe(false);

    expect(pendingQuestions(sid)).toEqual([]);
  });

  it('flattens the protocol response into the in-process result', async () => {
    const sid = await createSession();
    const resultPromise: Promise<QuestionResult> = requestQuestion(sid, makeRequest('q-3'));

    await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/q-3`, {
      kind: 'question',
      answers: {
        q_0: { kind: 'multi', option_ids: ['opt_0_0', 'opt_0_1'] },
      },
      method: 'click',
    });

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
    const single: Promise<QuestionResult> = requestQuestion(sid, 
      makeTwoQuestionRequest('q-t1'),
    );
    await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/q-t1`, {
      kind: 'question',
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

    const other: Promise<QuestionResult> = requestQuestion(sid, 
      makeTwoQuestionRequest('q-t2'),
    );
    await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/q-t2`, {
      kind: 'question',
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
    const resultPromise: Promise<QuestionResult> = requestQuestion(sid, 
      makeTwoQuestionRequest('q-t3'),
    );

    await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/q-t3`, {
      kind: 'question',
      answers: {
        q_0: { kind: 'single', option_id: 'opt_0_9' },
        q_9: { kind: 'single', option_id: 'opt_9_0' },
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
    const resultPromise: Promise<QuestionResult> = requestQuestion(sid, 
      makeTwoQuestionRequest('q-t4'),
    );

    await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/q-t4`, {
      kind: 'question',
      answers: {
        q_0: { kind: 'skipped' },
        q_1: { kind: 'skipped' },
      },
    });

    await expect(resultPromise).resolves.toEqual({ answers: {} });
  });

  it('dismisses a pending question', async () => {
    const sid = await createSession();
    const resultPromise: Promise<QuestionResult> = requestQuestion(sid, makeRequest('q-4'));

    const { body } = await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/q-4`, {
      kind: 'question',
      dismissed: true,
    });
    expect(body.code).toBe(0);
    expect(body.data.outcome).toBe('dismissed');
    expect(Number.isNaN(Date.parse(body.data.ended_at))).toBe(false);

    await expect(resultPromise).resolves.toBeNull();
    expect(pendingQuestions(sid)).toEqual([]);
  });

  it('returns 40902 on a duplicate resolve (recently-resolved window)', async () => {
    const sid = await createSession();
    enqueueQuestion(sid, makeRequest('q-5'));
    await postJson<RespondWire>(`/api/v1/sessions/${sid}/interactions/q-5`, {
      kind: 'question',
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
    });

    const dup = await postJson<null>(`/api/v1/sessions/${sid}/interactions/q-5`, {
      kind: 'question',
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
    });
    expect(dup.body.code).toBe(40902);
  });

  it('returns 40404 for an unknown question id', async () => {
    const sid = await createSession();
    const { body } = await postJson<null>(`/api/v1/sessions/${sid}/interactions/nope`, {
      kind: 'question',
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
    });
    expect(body.code).toBe(40404);
  });

  it('resolves a question whose id contains a colon', async () => {
    const sid = await createSession();
    const resultPromise: Promise<QuestionResult> = requestQuestion(sid, {
      id: 'AskUserQuestion:0',
      toolCallId: 'AskUserQuestion:0',
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    });

    expect(pendingQuestions(sid).map((i) => i.id)).toEqual(['AskUserQuestion:0']);

    const { body } = await postJson<RespondWire>(
      `/api/v1/sessions/${sid}/interactions/AskUserQuestion%3A0`,
      { kind: 'question', answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } },
    );
    expect(body.code).toBe(0);
    expect(body.data.outcome).toBe('answered');
    await expect(resultPromise).resolves.toEqual({ answers: { 'Pick one': 'Yes' } });
  });

  it('mints the question id instead of deriving it from the provider tool_call id', async () => {
    const sid = await createSession();
    const resultPromise: Promise<QuestionResult> = requestQuestion(sid, {
      toolCallId: 'AskUserQuestion:0',
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    });

    const [item] = pendingQuestions(sid);
    expect(item!.tags['toolCallId']).toBe('AskUserQuestion:0');
    expect(item!.id).not.toBe('AskUserQuestion:0');

    const { body } = await postJson<RespondWire>(
      `/api/v1/sessions/${sid}/interactions/${encodeURIComponent(item!.id)}`,
      { kind: 'question', answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } },
    );
    expect(body.code).toBe(0);
    expect(body.data.outcome).toBe('answered');
    await expect(resultPromise).resolves.toEqual({ answers: { 'Pick one': 'Yes' } });
  });

  it('rejects a body with both answers and dismissed, or with neither', async () => {
    const sid = await createSession();
    enqueueQuestion(sid, makeRequest('q-6'));
    const url = `/api/v1/sessions/${sid}/interactions/q-6`;

    const both = await postJson<null>(url, {
      kind: 'question',
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
      dismissed: true,
    });
    expect(both.body.code).toBe(40001);
    const neither = await postJson<null>(url, { kind: 'question' });
    expect(neither.body.code).toBe(40001);

    expect(pendingQuestions(sid).map((i) => i.id)).toEqual(['q-6']);
  });

  it('returns 40902 on a duplicate resolve of a colon-id question', async () => {
    const sid = await createSession();
    enqueueQuestion(sid, {
      id: 'AskUserQuestion:1',
      toolCallId: 'AskUserQuestion:1',
      questions: [{ question: 'Pick one', options: [{ label: 'Yes' }] }],
    });
    const url = `/api/v1/sessions/${sid}/interactions/AskUserQuestion%3A1`;
    await postJson<RespondWire>(url, {
      kind: 'question',
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
    });

    const dup = await postJson<null>(url, {
      kind: 'question',
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
    });
    expect(dup.body.code).toBe(40902);
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/nope/interactions/nope', {
      kind: 'question',
      dismissed: true,
    });
    expect(body.code).toBe(40401);
  });
});
