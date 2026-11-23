import { edit, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('approve', {
  positive: {
    'approves a pending edit so the tool runs': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model, workspace }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('Edited b.txt.'));
        await product.send('Change old to new in b.txt.');
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
        await workspace.expectFile('b.txt', 'new\n');
      },
    },
  },
  negative: {
    'fails when the turn ends without asking for approval': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I read a.txt.'));
        await product.send('Read a.txt.');
        await expect(product.approve()).rejects.toThrow('found no approval');
        await product.expectReply('I read a.txt.');
      },
    },
  },
});
