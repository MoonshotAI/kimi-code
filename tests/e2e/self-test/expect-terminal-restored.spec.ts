import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('expectTerminalRestored', {
  positive: {
    'finds the terminal back in its normal input mode after the CLI exits': {
      run: async ({ product, model }) => {
        model.script(say('Leaving now.'));
        await product.send('Say you are leaving.');
        await product.waitIdle();
        await product.expectReply('Leaving now.');
        await product.exit();
        await product.expectTerminalRestored();
      },
    },
  },
  negative: {
    'fails while the CLI still owns the terminal': {
      run: async ({ product, model }) => {
        await expect(product.expectTerminalRestored()).rejects.toThrow('call exit() first');
        model.script(say('Still here.'));
        await product.send('Are you still here?');
        await product.waitIdle();
        await product.expectReply('Still here.');
      },
    },
  },
});
