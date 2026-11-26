import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('expectComposer', {
  positive: {
    'reads the prompt that undo put back in the input': {
      run: async ({ product, model }) => {
        model.script(say('Noted.'));
        await product.send('Put this back for me.');
        await product.waitIdle();
        await product.undo();
        await product.expectComposer('Put this back for me.');
      },
    },
    'reads an empty input once a prompt is sent': {
      run: async ({ product, model }) => {
        model.script(say('Sent and answered.'));
        await product.send('Send this right away.');
        await product.waitIdle();
        await product.expectComposer('');
        await product.expectReply('Sent and answered.');
      },
    },
  },
  negative: {
    'fails when the input holds other text': {
      run: async ({ product, model }) => {
        model.script(say('Noted.'));
        await product.send('The prompt that comes back.');
        await product.waitIdle();
        await product.undo();
        await expect(product.expectComposer('A prompt nobody typed.')).rejects.toThrow('but it holds');
        await product.expectComposer('The prompt that comes back.');
      },
    },
    'does not read a prompt that was sent for one still in the input': {
      run: async ({ product, model }) => {
        model.script(say('Got it.'));
        await product.send('Already on its way.');
        await product.waitIdle();
        await expect(product.expectComposer('Already on its way.')).rejects.toThrow('but it holds ""');
        await product.expectReply('Got it.');
      },
    },
  },
});
