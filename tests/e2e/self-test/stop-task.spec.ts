import { bash, held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const LOOP = "while true; do printf 'tick\\n'; sleep 1; done";
const GATED = "printf 'rea%s\\n' dy; while [ ! -f gate.txt ]; do sleep 0.1; done; printf 'don%s\\n' e";

selfTest('stopTask', {
  positive: {
    'stops a running background task and the model hears about it': {
      run: async ({ product, model }) => {
        model.script(bash({ command: LOOP, description: 'Watch the logs', run_in_background: true }), say('Watching.'), held('stopped', say('Stopped watching.')));
        await product.send('Watch the logs in the background.');
        await product.approve();
        await product.waitIdle();
        await product.stopTask('Watch the logs');
        await model.hold('stopped').reached();
        model.hold('stopped').release();
        await product.waitIdle();
        await product.expectReply('Stopped watching.');
        await product.expectTask({ description: 'Watch the logs', status: 'stopped' });
        expect(model.requests('main')[2]?.userTextsSinceReply.join('\n')).toContain('type="task.killed"');
      },
    },
  },
  negative: {
    'fails for a task that already finished': {
      run: async ({ product, model, workspace }) => {
        model.script(bash({ command: GATED, description: 'Run the slow build', run_in_background: true }), say('Started it.'), held('notified', say('It finished.')));
        await product.send('Start the slow build in the background.');
        await product.approve();
        await product.waitIdle();
        await workspace.write('gate.txt', '');
        await model.hold('notified').reached();
        model.hold('notified').release();
        await product.waitIdle();
        await expect(product.stopTask('Run the slow build')).rejects.toThrow('needs a running task');
        await product.expectReply('It finished.');
      },
    },
  },
});
