import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('removeWorkspace', {
  positive: {
    'removes the project from the sidebar and leaves its folder alone': {
      workspace: { 'notes.txt': 'keep me\n' },
      run: async ({ product, model, workspace }) => {
        model.script(say('The first answer.'), say('Back again.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.removeWorkspace();
        await workspace.expectFile('notes.txt', 'keep me\n');
        await product.addWorkspace();
        await product.send('Are you back?');
        await product.waitIdle();
        await product.expectReply('Back again.');
      },
    },
  },
  negative: {
    'fails when the project is no longer in the sidebar': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('Back again.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.removeWorkspace();
        await expect(product.removeWorkspace()).rejects.toThrow('found no project');
        await product.addWorkspace();
        await product.send('Are you back?');
        await product.waitIdle();
        await product.expectReply('Back again.');
      },
    },
  },
});
