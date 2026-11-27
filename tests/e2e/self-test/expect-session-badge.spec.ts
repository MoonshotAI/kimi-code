import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('expectSessionBadge', {
  positive: {
    'finds the unread mark on a session that finished while another was open, and no mark once it is opened': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), held('working', say('Finished while away.')));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.newSession();
        await product.send('Ask the second question.');
        await model.hold('working').reached();
        await product.openSession('Ask the first question.');
        model.hold('working').release();
        await product.expectSessionBadge('Ask the second question.', 'unread');
        await product.expectSessionBadge('Ask the first question.', 'none');
        await product.openSession('Ask the second question.');
        await product.expectSessionBadge('Ask the second question.', 'none');
      },
    },
  },
  negative: {
    'fails when the session shows another mark or none, or no session has the title': {
      run: async ({ product, model }) => {
        model.script(say('The only answer.'));
        await product.send('Ask the only question.');
        await product.waitIdle();
        await expect(product.expectSessionBadge('Ask the only question.', 'unread')).rejects.toThrow('but it shows no mark');
        await expect(product.expectSessionBadge('Ask the only question.', 'approval')).rejects.toThrow('but it shows no mark');
        await expect(product.expectSessionBadge('A title nobody wrote', 'none')).rejects.toThrow('no session has that title');
        await product.expectReply('The only answer.');
      },
    },
  },
});
