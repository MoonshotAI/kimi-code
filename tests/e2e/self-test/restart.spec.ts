import { bash, held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const COMMAND = 'echo $((40 + 2))';

selfTest('restart', {
  positive: {
    'reopens the same conversation and keeps it going': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'));
        await product.send('Ask the first question.');
        await product.waitIdle();
        await product.restart();
        await product.expectTranscript('Ask the first question.');
        await product.expectTranscript('The first answer.');
        expect(model.requests('main')).toHaveLength(1);
        await product.send('Ask the second question.');
        await product.waitIdle();
        await product.expectReply('The second answer.');
        expect(model.requests('main')[1]?.texts('user')).toContain('Ask the first question.');
      },
    },
    'lets the latest-turn checks read the last turn restored from before the restart': {
      run: async ({ product, model }) => {
        model.script(bash(COMMAND), say('It printed forty-two.'));
        await product.send('Print forty-two.');
        await product.approve();
        await product.waitIdle();
        await product.restart();
        await product.expectTool({ name: 'Bash', target: COMMAND, status: 'done', output: '42' });
        await product.expectReply('It printed forty-two.');
        await product.expectAbsent('It printed forty-three.');
      },
    },
    'reopens a product that has not had a turn yet': {
      run: async ({ product, model }) => {
        await product.restart();
        model.script(say('Hello after a quiet restart.'));
        await product.send('Say hello.');
        await product.waitIdle();
        await product.expectReply('Hello after a quiet restart.');
      },
    },
  },
  negative: {
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished after all.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.restart()).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished after all.');
      },
    },
    'does not take a reply of an earlier restored turn for the latest one': {
      run: async ({ product, model }) => {
        model.script(say('The earlier answer.'), say('The later answer.'));
        await product.send('Ask the earlier question.');
        await product.waitIdle();
        await product.send('Ask the later question.');
        await product.waitIdle();
        await product.restart();
        await expect(product.expectReply('The earlier answer.')).rejects.toThrow('The earlier answer.');
        await product.expectReply('The later answer.');
        await product.expectTranscript('The earlier answer.');
      },
    },
  },
});
