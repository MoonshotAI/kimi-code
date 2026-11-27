import { edit, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('setDefaultPermissionMode', {
  positive: {
    'starts the next new session in the chosen default': {
      workspace: { 'b.txt': 'one\n' },
      run: async ({ product, model, workspace }) => {
        model.script(say('Hello.'), edit({ path: 'b.txt', old_string: 'one', new_string: 'two' }), say('Changed b.txt.'));
        await product.send('Say hello.');
        await product.waitIdle();
        await product.setDefaultPermissionMode('yolo');
        await product.newSession();
        await product.send('Change b.txt.');
        await product.waitIdle();
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
        await product.expectReply('Changed b.txt.');
        await workspace.expectFile('b.txt', 'two\n');
      },
    },
  },
  negative: {
    'fails when that is already the default': {
      run: async ({ product, model }) => {
        await expect(product.setDefaultPermissionMode('manual')).rejects.toThrow('already the default permission');
        model.script(say('Still asking first.'));
        await product.send('Answer.');
        await product.waitIdle();
        await product.expectReply('Still asking first.');
      },
    },
  },
});
