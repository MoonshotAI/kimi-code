import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const COMMAND = "printf 'rea%s\\n' dy; while [ ! -f gate.txt ]; do sleep 0.1; done; printf 'don%s\\n' e";

selfTest('reload', {
  positive: {
    'comes back to the same conversation after the page reloads while a command runs': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(COMMAND), say('The command finished.'));
        await product.send('Run the slow command.');
        await product.approve();
        await product.expectTool({ name: 'Bash', target: COMMAND, status: 'running', output: 'ready' });
        await product.reload();
        await product.expectTranscript('Run the slow command.');
        await workspace.write('gate.txt', '');
        await product.waitIdle();
        await product.expectReply('The command finished.');
        expect(model.requests('main')).toHaveLength(2);
      },
    },
    'comes back to an idle conversation after the page reloads': {
      run: async ({ product, model }) => {
        model.script(say('Hello there.'));
        await product.send('Say hello.');
        await product.waitIdle();
        await product.reload();
        await product.expectTranscript('Hello there.');
        expect(model.requests('main')).toHaveLength(1);
      },
    },
  },
  negative: {
    'does not take a reply of an earlier turn for the latest one after the reload': {
      run: async ({ product, model }) => {
        model.script(say('The earlier answer.'), say('The later answer.'));
        await product.send('Ask the earlier question.');
        await product.waitIdle();
        await product.send('Ask the later question.');
        await product.waitIdle();
        await product.reload();
        await expect(product.expectReply('The earlier answer.')).rejects.toThrow('The earlier answer.');
        await product.expectReply('The later answer.');
      },
    },
  },
});
