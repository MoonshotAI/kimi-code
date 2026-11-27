import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const FIRST = 'testkit-model';
const SECOND = 'Second Model';
const TWO_MODELS = { config: { models: { second: { provider: 'testkit', model: 'testkit-second-model', maxContextSize: 262_144, displayName: SECOND } } } };

selfTest('switchModel', {
  positive: {
    'switches to another model in the middle of a session, so the next request goes to it': {
      ...TWO_MODELS,
      run: async ({ product, model }) => {
        model.script(say('Answered by the first model.'), say('Answered by the second model.'));
        await product.send('Who answers first?');
        await product.waitIdle();
        await product.switchModel(SECOND);
        await product.send('Who answers now?');
        await product.waitIdle();
        await product.expectReply('Answered by the second model.');
        expect(model.requests('main').map((request) => request.view.model)).toEqual(['testkit-model', 'testkit-second-model']);
      },
    },
    'switches back to the first model': {
      ...TWO_MODELS,
      run: async ({ product, model }) => {
        model.script(say('Answered by the first model.'), say('Answered by the first model again.'));
        await product.send('Who answers first?');
        await product.waitIdle();
        await product.switchModel(SECOND);
        await product.switchModel(FIRST);
        await product.send('Who answers now?');
        await product.waitIdle();
        await product.expectReply('Answered by the first model again.');
        expect(model.requests('main').map((request) => request.view.model)).toEqual(['testkit-model', 'testkit-model']);
      },
    },
  },
  negative: {
    'fails when the session already uses that model': {
      ...TWO_MODELS,
      run: async ({ product, model }) => {
        await expect(product.switchModel(FIRST)).rejects.toThrow('already the model');
        model.script(say('Still the first model.'));
        await product.send('Which model answers?');
        await product.waitIdle();
        await product.expectReply('Still the first model.');
        expect(model.requests('main')[0]?.view.model).toBe('testkit-model');
      },
    },
    'fails for a model the configuration does not have': {
      run: async ({ product, model }) => {
        await expect(product.switchModel(SECOND)).rejects.toThrow('offers only');
        model.script(say('Still the only model.'));
        await product.send('Which model answers?');
        await product.waitIdle();
        await product.expectReply('Still the only model.');
        expect(model.requests('main')[0]?.view.model).toBe('testkit-model');
      },
    },
    'fails while a turn is running': {
      ...TWO_MODELS,
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished on the first model.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.switchModel(SECOND)).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished on the first model.');
        expect(model.requests('main')[0]?.view.model).toBe('testkit-model');
      },
    },
  },
});
