import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const BROKEN_PERMISSION = { config: { extra: { permission: { rules: 'deny everything' } } } };

selfTest('expectNotice', {
  positive: {
    'reads the warning about a config section that was invalid before the product started': {
      ...BROKEN_PERMISSION,
      run: async ({ product, model }) => {
        model.script(say('Still answering.'));
        await product.expectNotice('Ignored invalid config section [permission]: rules[0]');
        await product.send('Are you still there?');
        await product.waitIdle();
        await product.expectReply('Still answering.');
      },
    },
    'reads the warning about a config section the user broke while the product was open': {
      run: async ({ product, model, configure }) => {
        model.script(say('First answer.'));
        await product.send('Answer once.');
        await product.waitIdle();
        await product.expectReply('First answer.');
        await configure((config) => ({ ...config, extra: { ...config.extra, loop_control: { max_steps_per_turn: 'many' } } }));
        await product.reload();
        await product.expectNotice('Ignored invalid config section [loop_control]: max_steps_per_turn');
      },
    },
  },
  negative: {
    'fails when no notice shows the text': {
      run: async ({ product, model }) => {
        model.script(say('Nothing to warn about.'));
        await product.send('Is the config fine?');
        await product.waitIdle();
        await expect(product.expectNotice('Ignored invalid config section')).rejects.toThrow('found no notice');
        await product.expectReply('Nothing to warn about.');
      },
    },
    'does not take a user message for a notice': {
      run: async ({ product, model }) => {
        model.script(say('Read it.'));
        await product.send('Ignored invalid config section, said nobody.');
        await product.waitIdle();
        await expect(product.expectNotice('Ignored invalid config section')).rejects.toThrow('found no notice');
        await product.expectReply('Read it.');
      },
    },
  },
});
