import { read, say, write } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('rejectWithFeedback', {
  positive: {
    'rejects a pending write and gives the model the reason': {
      run: async ({ product, model, workspace }) => {
        model.script(write({ path: 'docs/d.md', content: '# Draft\n' }), say('I will not write it.'));
        await product.send('Write a draft doc.');
        await product.rejectWithFeedback('Put it in README instead');
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain('Reason: Put it in README instead');
        await product.expectTool({ name: 'Write', target: 'docs/d.md', status: 'rejected' });
        await workspace.expectMissing('docs/d.md');
      },
    },
  },
  negative: {
    'fails when the turn ends without asking for approval': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I read a.txt.'));
        await product.send('Read a.txt.');
        await expect(product.rejectWithFeedback('Not now')).rejects.toThrow('found no approval');
        await product.expectReply('I read a.txt.');
      },
    },
  },
});
