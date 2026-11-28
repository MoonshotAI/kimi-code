import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

function thinkingOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'thinking' in body ? body.thinking : undefined;
}

scenario(
  'answers the next message with the model and the thinking level the user switched to',
  {
    config: {
      models: { large: { provider: 'testkit', model: 'testkit-large', maxContextSize: 262_144, capabilities: ['thinking'], extra: { support_efforts: ['low', 'medium', 'high'] } } },
    },
  },
  async ({ product, model }) => {
    model.script(say('From the default model.'), say('From the large model, thinking a little.'));

    await product.send('Answer with the default model.');
    await product.waitIdle();
    await product.switchModel('testkit-large');
    await product.setThinkingEffort('low');
    await product.send('Answer with the large model.');
    await product.waitIdle();

    await product.expectReply('From the large model, thinking a little.');
    const [first, second] = model.requests('main');
    expect(first?.view.model).toBe('testkit-model');
    expect(second?.view.model).toBe('testkit-large');
    expect(thinkingOf(first?.body)).toEqual({ type: 'disabled' });
    expect(thinkingOf(second?.body)).toMatchObject({ type: 'enabled', effort: 'low' });
  },
);
