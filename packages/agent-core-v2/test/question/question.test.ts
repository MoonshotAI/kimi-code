import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IQuestionService } from '#/question/question';
import { QuestionService } from '#/question/questionService';

describe('QuestionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IQuestionService, QuestionService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('request parks until answer resolves it', async () => {
    const svc = ix.get(IQuestionService);
    const p = svc.request({ id: 'q1', prompt: 'name?' });
    expect(svc.listPending()).toEqual([{ id: 'q1', prompt: 'name?' }]);
    svc.answer('q1', 'kimi');
    await expect(p).resolves.toBe('kimi');
    expect(svc.listPending()).toEqual([]);
  });
});
