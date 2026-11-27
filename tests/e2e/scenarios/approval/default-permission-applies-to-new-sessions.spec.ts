import { edit, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'applies a new default permission mode to new sessions, and leaves the open session as it was',
  {
    onlyOn: ['desktop', 'web'],
    reason: 'Only the Desktop and Web settings change the default for new sessions; the terminal UI changes the current session only, and an editor sets the mode of each session over ACP.',
    workspace: { 'a.txt': 'one\n', 'b.txt': 'one\n' },
  },
  async ({ product, model, workspace }) => {
    model.script(
      say('Hello.'),
      edit({ path: 'a.txt', old_string: 'one', new_string: 'two' }),
      say('Changed a.txt.'),
      edit({ path: 'b.txt', old_string: 'one', new_string: 'two' }),
      say('Changed b.txt.'),
    );

    await product.send('Say hello.');
    await product.waitIdle();
    await product.setDefaultPermissionMode('yolo');

    await product.send('Change a.txt.');
    await product.expectApproval({ name: 'Edit', target: 'a.txt' });
    await product.approve();
    await product.waitIdle();
    await product.expectReply('Changed a.txt.');

    await product.newSession();
    await product.send('Change b.txt.');
    await product.waitIdle();
    await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
    await product.expectReply('Changed b.txt.');

    await workspace.expectFile('a.txt', 'two\n');
    await workspace.expectFile('b.txt', 'two\n');
    expect(model.requests('main')).toHaveLength(5);
  },
);
