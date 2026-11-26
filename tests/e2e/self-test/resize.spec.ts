import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const COMMAND = "printf 'r\\n' > r.txt";

selfTest('resize', {
  positive: {
    'narrows the window and widens it back while the product keeps taking messages': {
      run: async ({ product, model }) => {
        model.script(say('First answer.'), say('Second answer.'), say('Third answer.'));
        await product.send('Say something.');
        await product.waitIdle();
        await product.resize('narrow');
        await product.send('Say something else.');
        await product.waitIdle();
        await product.expectReply('Second answer.');
        await product.resize('normal');
        await product.send('One more time.');
        await product.waitIdle();
        await product.expectReply('Third answer.');
      },
    },
    'narrows the window while an approval waits, and the approval still goes through': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(COMMAND), say('Written.'));
        await product.send('Write r.txt with a shell command.');
        await product.expectApproval({ name: 'Bash', target: COMMAND });
        await product.resize('narrow');
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: COMMAND, status: 'done' });
        await workspace.expectFile('r.txt', 'r\n');
      },
    },
    'keeps the size across a restart, the way a user reopens the product in the same window': {
      run: async ({ product, model }) => {
        model.script(say('Before.'), say('After.'));
        await product.send('Before the restart.');
        await product.waitIdle();
        await product.resize('narrow');
        await product.restart();
        await expect(product.resize('narrow')).rejects.toThrow('already narrow');
        await product.resize('normal');
        await product.send('After the restart.');
        await product.waitIdle();
        await product.expectReply('After.');
      },
    },
  },
  negative: {
    'fails when the window already has that size': {
      run: async ({ product, model }) => {
        await expect(product.resize('normal')).rejects.toThrow('already normal');
        await product.resize('narrow');
        await expect(product.resize('narrow')).rejects.toThrow('already narrow');
        model.script(say('Still here.'));
        await product.send('Are you still here?');
        await product.waitIdle();
        await product.expectReply('Still here.');
      },
    },
  },
});
