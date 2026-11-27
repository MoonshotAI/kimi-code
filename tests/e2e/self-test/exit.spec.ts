import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('exit', {
  positive: {
    'leaves the terminal UI after a turn': {
      run: async ({ product, model }) => {
        model.script(say('Goodbye from the turn.'));
        await product.send('Say goodbye.');
        await product.waitIdle();
        await product.expectReply('Goodbye from the turn.');
        await product.exit();
      },
    },
  },
  negative: {
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Done before leaving.'), 1));
        await product.send('Keep going.');
        await model.hold('busy').reached();
        await expect(product.exit()).rejects.toThrow('while a turn was running');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Done before leaving.');
      },
    },
  },
});
