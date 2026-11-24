import { bash, edit, held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('stop', {
  positive: {
    'stops a turn that is still streaming its reply': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model }) => {
        model.script(held('mid-reply', edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }, { text: 'Let me update b.txt.' }), 1));
        await product.send('Update b.txt.');
        await model.hold('mid-reply').reached();
        await product.expectReply('Let me update b.txt.');
        await product.stop();
        await product.waitIdle();
        model.hold('mid-reply').release();
        expect(model.requests('main').map((request) => request.state)).toEqual(['aborted']);
      },
    },
    'stops a command that is running and has already printed, and takes the next message': {
      run: async ({ product, model }) => {
        const command = "printf 'rea%s\\n' dy; sleep 30";
        model.script(bash(command), say('The command was stopped.'));
        await product.send('Print one word, then wait.');
        await product.approve();
        await product.expectTool({ name: 'Bash', target: command, status: 'running', output: 'ready' });
        await product.stop();
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(1);
        await product.send('What happened to the command?');
        await product.waitIdle();
        await product.expectReply('The command was stopped.');
      },
    },
  },
  negative: {
    'fails when no turn is running': {
      run: async ({ product, model }) => {
        await expect(product.stop()).rejects.toThrow('needs a running turn');
        model.script(say('Nothing was stopped.'));
        await product.send('Did anything stop?');
        await product.waitIdle();
        await expect(product.stop()).rejects.toThrow('needs a running turn');
        await product.expectReply('Nothing was stopped.');
      },
    },
  },
});
