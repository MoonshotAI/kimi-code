import { bash, held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const GATED = "printf 'rea%s\\n' dy; while [ ! -f gate.txt ]; do sleep 0.1; done; printf 'don%s\\n' e";

selfTest('background', {
  positive: {
    'moves the running command to the background and lets the turn go on': {
      run: async ({ product, model, workspace }) => {
        model.script(bash({ command: GATED, description: 'Run the slow build' }), say('It runs in the background now.'), held('notified', say('It finished.')));
        await product.send('Run the slow build.');
        await product.approve();
        await product.expectTool({ name: 'Bash', target: GATED, status: 'running', output: 'ready' });
        await product.background();
        await product.waitIdle();
        await product.expectReply('It runs in the background now.');
        expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain('detached_by_user: true');
        await workspace.write('gate.txt', '');
        await model.hold('notified').reached();
        model.hold('notified').release();
        await product.waitIdle();
      },
    },
  },
  negative: {
    'fails when no command is running': {
      run: async ({ product, model }) => {
        model.script(held('writing', say(['Thinking it ', 'over.']), 1));
        await product.send('Think it over.');
        await model.hold('writing').reached();
        await expect(product.background()).rejects.toThrow('found no running command');
        model.hold('writing').release();
        await product.waitIdle();
        await product.expectReply('over.');
      },
    },
  },
});
