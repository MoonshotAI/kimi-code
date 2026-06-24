import { describe, expect, it } from 'vitest';

import { QuestionService } from '#/question/questionService';

describe('QuestionService', () => {
  it('request parks until answer resolves it', async () => {
    const svc = new QuestionService();
    const p = svc.request({ id: 'q1', prompt: 'name?' });
    expect(svc.listPending()).toEqual([{ id: 'q1', prompt: 'name?' }]);
    svc.answer('q1', 'kimi');
    await expect(p).resolves.toBe('kimi');
    expect(svc.listPending()).toEqual([]);
  });
});
