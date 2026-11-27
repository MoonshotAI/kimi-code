import { bash, edit, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const COMMAND = "printf 'y\\n' > y.txt";

selfTest('setPermissionMode', {
  positive: {
    'switches to Never Ask so an edit and a command run without asking': {
      workspace: { 'n.txt': 'a\n' },
      run: async ({ product, model, workspace }) => {
        await product.setPermissionMode('auto');
        model.script(edit({ path: 'n.txt', old_string: 'a', new_string: 'b' }), bash(COMMAND), say('Done without asking.'));
        await product.send('Edit n.txt and write y.txt.');
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(3);
        await product.expectTool({ name: 'Edit', target: 'n.txt', status: 'done' });
        await product.expectTool({ name: 'Bash', target: COMMAND, status: 'done' });
        await workspace.expectFile('n.txt', 'b\n');
        await workspace.expectFile('y.txt', 'y\n');
      },
    },
    'switches back to Always Ask so an edit asks again': {
      workspace: { 'n.txt': 'a\n' },
      run: async ({ product, model }) => {
        await product.setPermissionMode('auto');
        await product.setPermissionMode('manual');
        model.script(edit({ path: 'n.txt', old_string: 'a', new_string: 'b' }), say('I left n.txt alone.'));
        await product.send('Edit n.txt.');
        await product.expectApproval({ name: 'Edit', target: 'n.txt' });
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Edit', target: 'n.txt', status: 'rejected' });
      },
    },
  },
  negative: {
    'fails when the product is already in that mode': {
      run: async ({ product, model }) => {
        await expect(product.setPermissionMode('manual')).rejects.toThrow('already the permission mode');
        model.script(say('Still asking first.'));
        await product.send('Are you still asking first?');
        await product.waitIdle();
        await product.expectReply('Still asking first.');
      },
    },
    'fails while an approval is pending': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(COMMAND), say('I did not write it.'));
        await product.send('Write y.txt with a shell command.');
        await product.expectApproval({ name: 'Bash', target: COMMAND });
        await expect(product.setPermissionMode('auto')).rejects.toThrow('needs an idle product');
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: COMMAND, status: 'rejected' });
        await workspace.expectMissing('y.txt');
      },
    },
  },
});
