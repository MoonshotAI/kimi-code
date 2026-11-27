import { held, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('reload', {
  positive: {
    'returns once the session is reloaded, and the next turn still carries the earlier history': {
      workspace: { 'notes.txt': 'alpha\n' },
      run: async ({ product, model }) => {
        model.script(read('notes.txt'), say('It says alpha.'), say('Still here after the reload.'));
        await product.send('Read notes.txt.');
        await product.waitIdle();
        await product.expectReply('It says alpha.');
        await product.reload();
        await product.send('Are you still there?');
        await product.waitIdle();
        await product.expectReply('Still here after the reload.');
        const after = model.requests('main')[2];
        expect(after?.texts('user')).toContain('Read notes.txt.');
        expect(after?.texts('tool').join('\n')).toContain('alpha');
      },
    },
  },
  negative: {
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished before any reload.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.reload()).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished before any reload.');
      },
    },
    'fails before the first message, when no conversation is open to reload': {
      run: async ({ product, model }) => {
        await expect(product.reload()).rejects.toThrow('send one first');
        model.script(say('Hello from the first turn.'));
        await product.send('Say hello.');
        await product.waitIdle();
        await product.expectReply('Hello from the first turn.');
      },
    },
  },
});
