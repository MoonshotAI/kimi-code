import { edit, held, httpError, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('waitIdle', {
  positive: {
    'returns once a turn has completed': {
      run: async ({ product, model }) => {
        model.script(say('All done.'));
        await product.send('Finish a turn.');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.state)).toEqual(['finished']);
        await product.expectReply('All done.');
      },
    },
    'returns once a turn has failed, without judging it': {
      run: async ({ product, model }) => {
        model.script(httpError(400), say('Recovered.'));
        await product.send('Trigger a model failure.');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.state)).toEqual(['failed']);
        await product.send('Try again.');
        await product.waitIdle();
        await product.expectReply('Recovered.');
      },
    },
  },
  negative: {
    'does not return while the model is still replying': {
      run: async ({ product, model }) => {
        const order: string[] = [];
        model.script(held('reply', say('Finished late.')));
        await product.send('Reply late.');
        const idle = product.waitIdle().then(() => order.push('returned'));
        await model.hold('reply').reached();
        order.push('released');
        model.hold('reply').release();
        await idle;
        expect(order).toEqual(['released', 'returned']);
        await product.expectReply('Finished late.');
      },
    },
    'does not take reply text that looks like a failed turn for the end of the turn': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        const prompt = 'Quote the log, then answer.';
        model.script(
          read('a.txt', { text: 'Quoting the log:\n\nError: [example] this line is part of the reply.' }),
          held('answer', say('Final answer.')),
        );
        await product.send(prompt);
        await model.hold('answer').reached();
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await expect(product.send('Second prompt.')).rejects.toThrow('needs an idle product');
        model.hold('answer').release();
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.firstUserText)).toEqual([prompt, prompt]);
        await product.expectReply('Final answer.');
      },
    },
    'fails when an approval is still pending': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model, workspace }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('Edited b.txt.'));
        await product.send('Change old to new in b.txt.');
        await expect(product.waitIdle()).rejects.toThrow('found a pending approval');
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
        await workspace.expectFile('b.txt', 'new\n');
      },
    },
  },
});
