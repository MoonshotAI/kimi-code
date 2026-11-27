import { bash, held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const GATED = "printf 'rea%s\\n' dy; while [ ! -f gate.txt ]; do sleep 0.1; done; printf 'don%s\\n' e";

selfTest('expectTask', {
  positive: {
    'finds a background task while it runs and after it finished, with its output': {
      run: async ({ product, model, workspace }) => {
        model.script(bash({ command: GATED, description: 'Run the slow build', run_in_background: true }), say('Started it.'), held('notified', say('It finished.')));
        await product.send('Start the slow build in the background.');
        await product.approve();
        await product.waitIdle();
        await product.expectTask({ description: 'Run the slow build', status: 'running' });
        await workspace.write('gate.txt', '');
        await model.hold('notified').reached();
        model.hold('notified').release();
        await product.waitIdle();
        await product.expectTask({ description: 'Run the slow build', status: 'done', output: 'done' });
      },
    },
  },
  negative: {
    'fails for a status, an output or a task that does not match': {
      run: async ({ product, model, workspace }) => {
        model.script(bash({ command: GATED, description: 'Run the slow build', run_in_background: true }), say('Started it.'), held('notified', say('It finished.')));
        await product.send('Start the slow build in the background.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTask({ description: 'Run the slow build', status: 'done' })).rejects.toThrow('not ');
        await expect(product.expectTask({ description: 'Run the tests', status: 'running' })).rejects.toThrow('Run the tests');
        await workspace.write('gate.txt', '');
        await model.hold('notified').reached();
        model.hold('notified').release();
        await product.waitIdle();
        await expect(product.expectTask({ description: 'Run the slow build', status: 'done', output: 'never printed' })).rejects.toThrow('never printed');
        await product.expectReply('It finished.');
      },
    },
  },
});
