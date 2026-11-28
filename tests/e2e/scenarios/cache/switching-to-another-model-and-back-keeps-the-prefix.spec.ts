import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const FIRST = 'testkit-model';
const SECOND = 'Second Model';

scenario(
  'keeps the prompt cache prefix of the first model when the user switches to another model and back',
  { config: { models: { second: { provider: 'testkit', model: 'testkit-second-model', maxContextSize: 262_144, displayName: SECOND } } } },
  async ({ product, model }) => {
    model.script(say('Hello from the first model.'), say('Hello from the second model.'), say('Hello again from the first model.'));
    await product.send('Hello.');
    await product.waitIdle();
    await product.expectReply('Hello from the first model.');

    await product.switchModel(SECOND);
    await product.send('Who answers now?');
    await product.waitIdle();
    await product.expectReply('Hello from the second model.');

    await product.switchModel(FIRST);
    await product.send('And who answers now?');
    await product.waitIdle();
    await product.expectReply('Hello again from the first model.');

    const requests = model.requests('main');
    expect(requests.map((request) => request.view.model)).toEqual(['testkit-model', 'testkit-second-model', 'testkit-model']);
    expect(requests[2]?.texts('assistant')).toEqual(['Hello from the first model.', 'Hello from the second model.']);
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));

    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.model)).toEqual(['testkit-model', 'testkit-second-model', 'testkit-model']);
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, undefined, main[0]?.request]);
    expect(main.map((entry) => entry.break)).toEqual([undefined, undefined, undefined]);
    expect(main[2]?.reusedFrom).toBe(main[0]?.request);
    expect(main[2]?.reusedTokens).toBeGreaterThanOrEqual(main[0]?.totalTokens ?? Number.POSITIVE_INFINITY);
  },
);
