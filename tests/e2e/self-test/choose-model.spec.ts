import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const TWO_MODELS = { models: { large: { provider: 'testkit', model: 'testkit-large', maxContextSize: 262_144 } } };

selfTest('chooseModel', {
  positive: {
    'sends the next request to the model the user chose': {
      config: TWO_MODELS,
      run: async ({ product, model }) => {
        model.script(say('From the default model.'), say('From the large model.'));
        await product.send('Answer with the default model.');
        await product.waitIdle();
        await product.chooseModel('testkit-large');
        await product.send('Answer with the large model.');
        await product.waitIdle();
        await product.expectReply('From the large model.');
        expect(model.requests('main').map((request) => request.view.model)).toEqual(['testkit-model', 'testkit-large']);
      },
    },
  },
  negative: {
    'fails when no such model is configured': {
      config: TWO_MODELS,
      run: async ({ product, model }) => {
        await expect(product.chooseModel('testkit-missing')).rejects.toThrow('testkit-missing');
        model.script(say('Still the default model.'));
        await product.send('Answer.');
        await product.waitIdle();
        await product.expectReply('Still the default model.');
        expect(model.requests('main').map((request) => request.view.model)).toEqual(['testkit-model']);
      },
    },
    'fails when that model is already in use': {
      config: TWO_MODELS,
      run: async ({ product, model }) => {
        await expect(product.chooseModel('testkit-model')).rejects.toThrow('already');
        model.script(say('Still the default model.'));
        await product.send('Answer.');
        await product.waitIdle();
        await product.expectReply('Still the default model.');
      },
    },
  },
});
