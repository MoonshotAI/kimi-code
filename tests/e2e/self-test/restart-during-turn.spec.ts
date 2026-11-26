import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('restartDuringTurn', {
  positive: {
    'quits while the reply is streaming and reopens the same conversation with nothing running': {
      run: async ({ product, model }) => {
        model.script(held('answering', say(['The first half of the answer, ', 'and the second half.']), 1), say('Picked up after the restart.'));
        await product.send('Explain it slowly.');
        await model.hold('answering').reached();
        await product.restartDuringTurn();
        await product.waitIdle();
        await product.expectTranscript('Explain it slowly.');
        await product.send('Carry on.');
        await product.waitIdle();
        await product.expectReply('Picked up after the restart.');
      },
    },
  },
  negative: {
    'fails when no turn is running': {
      run: async ({ product, model }) => {
        model.script(say('Already done.'));
        await product.send('Answer quickly.');
        await product.waitIdle();
        await expect(product.restartDuringTurn()).rejects.toThrow('needs a running turn');
        await product.expectReply('Already done.');
      },
    },
  },
});
