import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('addWorkspace', {
  positive: {
    'adds the removed folder back as a project the user can work in': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('Working in the project again.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.removeWorkspace();
        await product.addWorkspace();
        await product.send('Work in the project.');
        await product.waitIdle();
        await product.expectReply('Working in the project again.');
        await product.expectSessions(['Work in the project.']);
      },
    },
  },
  negative: {
    'fails when the project is already in the sidebar': {
      run: async ({ product, model }) => {
        model.script(say('The only answer.'));
        await product.send('Ask the only question.');
        await product.waitIdle();
        await expect(product.addWorkspace()).rejects.toThrow('already in the sidebar');
        await product.expectReply('The only answer.');
      },
    },
  },
});
