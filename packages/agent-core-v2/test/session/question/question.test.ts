import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { DisposableStore } from '#/_base/di/lifecycle';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { type QuestionRequest, ISessionQuestionService } from '#/session/question/question';
import { SessionQuestionService } from '#/session/question/questionService';

const noopEventBus: IEventBus = {
  _serviceBrand: undefined,
  publish: () => undefined,
  subscribe: () => ({ dispose: () => undefined }),
};

function makeRequest(id: string): QuestionRequest {
  return {
    id,
    toolCallId: `tc-${id}`,
    questions: [
      {
        question: 'Pick one',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
  };
}

describe('ISessionQuestionService (Session scope facade over the interaction kernel)', () => {
  let disposables: DisposableStore;
  let host: ScopedTestHost;
  let session: Scope;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, ISessionInteractionService, SessionInteractionService, InstantiationType.Delayed, 'interaction');
    registerScopedService(LifecycleScope.Session, ISessionQuestionService, SessionQuestionService, InstantiationType.Delayed, 'question');

    disposables = new DisposableStore();
    host = createScopedTestHost([stubPair(IEventBus, noopEventBus)]);
    session = host.child(LifecycleScope.Session, 'session-a');
  });

  afterEach(() => {
    disposables.dispose();
    host.dispose();
  });

  it('request parks until answer resolves it with the rich result', async () => {
    const questions = session.accessor.get(ISessionQuestionService);

    const pending = questions.request(makeRequest('q1'));
    expect(questions.listPending().map((r) => r.id)).toEqual(['q1']);

    questions.answer('q1', { answers: { q_0: 'Yes' }, method: 'number_key' });
    await expect(pending).resolves.toEqual({ answers: { q_0: 'Yes' }, method: 'number_key' });
    expect(questions.listPending()).toEqual([]);
  });

  it('enqueue returns immediately and the answer streams over onDidResolve', () => {
    const interaction = session.accessor.get(ISessionInteractionService);
    const questions = session.accessor.get(ISessionQuestionService);

    const resolved: { id: string; response: unknown }[] = [];
    disposables.add(interaction.onDidResolve((r) => resolved.push(r)));

    const parked = questions.enqueue(makeRequest('q1'));
    expect(parked.id).toBe('q1');
    expect(questions.listPending().map((r) => r.id)).toEqual(['q1']);

    questions.answer('q1', { answers: { q_0: 'No' } });
    expect(resolved).toEqual([{ id: 'q1', response: { answers: { q_0: 'No' } } }]);
    expect(questions.listPending()).toEqual([]);
  });

  it('dismiss resolves a pending request with null', async () => {
    const questions = session.accessor.get(ISessionQuestionService);

    const pending = questions.request(makeRequest('q1'));
    questions.dismiss('q1');

    await expect(pending).resolves.toBeNull();
    expect(questions.listPending()).toEqual([]);
  });

  it('listPending returns the stored in-process payload', () => {
    const questions = session.accessor.get(ISessionQuestionService);
    questions.enqueue(makeRequest('q1'));

    const pending = questions.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: 'q1',
      toolCallId: 'tc-q1',
      questions: [{ question: 'Pick one' }],
    });
  });

  it('request with a pre-aborted signal resolves null and parks nothing', async () => {
    const questions = session.accessor.get(ISessionQuestionService);
    const controller = new AbortController();
    controller.abort();

    await expect(
      questions.request(makeRequest('q1'), { signal: controller.signal }),
    ).resolves.toBeNull();
    expect(questions.listPending()).toEqual([]);
  });

  it('aborting a parked request dismisses it and resolves the caller with null', async () => {
    const interaction = session.accessor.get(ISessionInteractionService);
    const questions = session.accessor.get(ISessionQuestionService);

    const resolved: { id: string; response: unknown }[] = [];
    disposables.add(interaction.onDidResolve((r) => resolved.push(r)));

    const controller = new AbortController();
    const pending = questions.request(makeRequest('q1'), { signal: controller.signal });
    expect(questions.listPending().map((r) => r.id)).toEqual(['q1']);

    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(questions.listPending()).toEqual([]);
    expect(resolved).toEqual([{ id: 'q1', response: null }]);
    expect(interaction.isRecentlyResolved('q1')).toBe(true);
  });

  it('an answer that arrives before the abort still wins', async () => {
    const questions = session.accessor.get(ISessionQuestionService);

    const controller = new AbortController();
    const pending = questions.request(makeRequest('q1'), { signal: controller.signal });
    questions.answer('q1', { answers: { q_0: 'Yes' } });

    await expect(pending).resolves.toEqual({ answers: { q_0: 'Yes' } });
    controller.abort();
    expect(questions.listPending()).toEqual([]);
  });

  it('Session scope isolates brokers: a question parked in A is invisible to B', () => {
    const sessionB = host.child(LifecycleScope.Session, 'session-b');
    const questionsA = session.accessor.get(ISessionQuestionService);
    const questionsB = sessionB.accessor.get(ISessionQuestionService);

    questionsA.enqueue(makeRequest('q1'));
    expect(questionsA.listPending().map((r) => r.id)).toEqual(['q1']);
    expect(questionsB.listPending()).toEqual([]);

    questionsB.answer('q1', { answers: { q_0: 'Yes' } });
    expect(questionsA.listPending().map((r) => r.id)).toEqual(['q1']);
  });
});
