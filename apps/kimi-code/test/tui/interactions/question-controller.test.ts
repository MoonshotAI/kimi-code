import type { CoreSession, PendingQuestion, QuestionResult } from '#/core/index';
import { describe, expect, it, vi } from 'vitest';

import { QuestionController } from '#/tui/interactions/question-controller';

function pending(id: string, text = 'Q1?'): PendingQuestion {
  return {
    id,
    agentId: 'main',
    request: {
      toolCallId: id,
      questions: [{ question: text, options: [{ label: 'Alpha' }] }],
    },
  };
}

function makeQuestionBroker(initial: readonly PendingQuestion[] = []) {
  const pendings = [...initial];
  const changeListeners = new Set<() => void>();
  const resolveListeners = new Set<(id: string) => void>();
  const remove = (id: string): void => {
    const idx = pendings.findIndex((p) => p.id === id);
    if (idx >= 0) pendings.splice(idx, 1);
  };
  const answer = vi.fn((id: string, _result: Exclude<QuestionResult, null>) => {
    remove(id);
    for (const listener of resolveListeners) listener(id);
  });
  const dismiss = vi.fn((id: string) => {
    remove(id);
    for (const listener of resolveListeners) listener(id);
  });
  return {
    list: () => pendings,
    onDidChangePending: (listener: () => void) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onDidResolve: (listener: (id: string) => void) => {
      resolveListeners.add(listener);
      return () => resolveListeners.delete(listener);
    },
    answer,
    dismiss,
    externalResolve(id: string): void {
      remove(id);
      for (const listener of resolveListeners) listener(id);
    },
  };
}

function sessionOf(broker: ReturnType<typeof makeQuestionBroker>): CoreSession {
  return { questions: broker } as unknown as CoreSession;
}

describe('QuestionController', () => {
  it('presents a parked pending and writes back the answer', async () => {
    const broker = makeQuestionBroker([pending('q-1')]);
    const controller = new QuestionController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    controller.attach(sessionOf(broker));
    expect(showPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-1' }));

    controller.respond({ answers: ['Alpha'], method: 'number_key' });
    await vi.waitFor(() => {
      expect(broker.answer).toHaveBeenCalledWith('q-1', {
        answers: { 'Q1?': 'Alpha' },
        method: 'number_key',
      });
    });
    expect(hidePanel).toHaveBeenCalledOnce();
  });

  it('dismisses the pending on an empty answer set', async () => {
    const broker = makeQuestionBroker([pending('q-1')]);
    const controller = new QuestionController();
    controller.setUIHooks({ showPanel: vi.fn(), hidePanel: vi.fn() });

    controller.attach(sessionOf(broker));
    controller.respond({ answers: [''] });

    await vi.waitFor(() => {
      expect(broker.dismiss).toHaveBeenCalledWith('q-1');
    });
    expect(broker.answer).not.toHaveBeenCalled();
  });

  it('retracts the dialog when a pending is resolved externally', async () => {
    const broker = makeQuestionBroker([pending('q-1'), pending('q-2', 'Q2?')]);
    const controller = new QuestionController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    controller.attach(sessionOf(broker));
    expect(showPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-1' }));

    broker.externalResolve('q-1');
    expect(hidePanel).not.toHaveBeenCalled();
    expect(showPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-2' }));
    expect(broker.answer).not.toHaveBeenCalled();
    expect(broker.dismiss).not.toHaveBeenCalled();
  });

  it('detach retracts the dialog without answering or dismissing', () => {
    const broker = makeQuestionBroker([pending('q-1')]);
    const controller = new QuestionController();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel: vi.fn(), hidePanel });

    const teardown = controller.attach(sessionOf(broker));
    teardown();

    expect(hidePanel).toHaveBeenCalledOnce();
    expect(broker.answer).not.toHaveBeenCalled();
    expect(broker.dismiss).not.toHaveBeenCalled();
  });

  it('dismisses the pending when the dialog path throws', async () => {
    const broker = makeQuestionBroker([pending('q-1')]);
    const controller = new QuestionController();
    controller.setUIHooks({
      showPanel: () => {
        throw new Error('render boom');
      },
      hidePanel: vi.fn(),
    });

    controller.attach(sessionOf(broker));

    await vi.waitFor(() => {
      expect(broker.dismiss).toHaveBeenCalledWith('q-1');
    });
    expect(broker.answer).not.toHaveBeenCalled();
  });
});
