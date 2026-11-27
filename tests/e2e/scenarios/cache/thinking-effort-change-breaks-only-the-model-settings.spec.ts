import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const EFFORT_CHANGED = 'the user changed the thinking effort, which is part of the model settings';

scenario(
  'breaks the prompt cache only in the model settings, and continues from there, when the user changes the thinking effort',
  {
    config: {
      models: {
        testkit: {
          provider: 'testkit',
          model: 'testkit-model',
          maxContextSize: 262_144,
          capabilities: ['thinking'],
          extra: { support_efforts: ['low', 'high'], default_effort: 'low' },
        },
      },
    },
  },
  async ({ product, model }) => {
    model.script(say('Thought a little.'), say('Thought hard.'), say('Still thinking hard.'));
    await product.send('Think a little about the plan.');
    await product.waitIdle();
    await product.expectReply('Thought a little.');

    await product.setThinkingEffort('high');
    model.expectCacheBreak(EFFORT_CHANGED, { at: 'header' });
    await product.send('Now think hard about it.');
    await product.waitIdle();
    await product.expectReply('Thought hard.');

    await product.send('Keep going.');
    await product.waitIdle();
    await product.expectReply('Still thinking hard.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.body)).toMatchObject([
      { thinking: { type: 'enabled', effort: 'low' } },
      { thinking: { type: 'enabled', effort: 'high' } },
      { thinking: { type: 'enabled', effort: 'high' } },
    ]);
    expect(requests.map((request) => request.view.model)).toEqual(['testkit-model', 'testkit-model', 'testkit-model']);
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    const before = requests[0]?.view.messages ?? [];
    expect(requests[1]?.view.messages.slice(0, before.length)).toEqual(before);
    expect(requests[1]?.texts('assistant')).toEqual(['Thought a little.']);

    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.map((entry) => entry.break?.part)).toEqual([undefined, 'header', undefined]);
    expect(main[1]?.break?.region).toBe('params');
    expect(main[1]?.explanation).toBe(EFFORT_CHANGED);
    expect(main[2]?.reusedTokens).toBeGreaterThanOrEqual(main[1]?.totalTokens ?? Number.POSITIVE_INFINITY);
  },
);
