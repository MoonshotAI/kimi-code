import { edit, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'starts a new session in the permission mode the user picked last',
  {
    except: {
      acp: 'An editor sets the mode of each session with session/set_mode: a session it opens with session/new starts in the default mode, not in the mode of the session before it.',
    },
    workspace: { 'a.txt': 'one\n', 'b.txt': 'one\n' },
  },
  async ({ product, model, workspace }) => {
    model.script(
      edit({ path: 'a.txt', old_string: 'one', new_string: 'two' }),
      say('Changed a.txt.'),
      edit({ path: 'b.txt', old_string: 'one', new_string: 'two' }),
      say('Changed b.txt.'),
    );

    await product.send('Change a.txt.');
    await product.expectApproval({ name: 'Edit', target: 'a.txt' });
    await product.approve();
    await product.waitIdle();
    await product.expectReply('Changed a.txt.');

    await product.setPermissionMode('yolo');
    await product.newSession();
    await product.send('Change b.txt.');
    await product.waitIdle();
    await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
    await product.expectReply('Changed b.txt.');

    await workspace.expectFile('a.txt', 'two\n');
    await workspace.expectFile('b.txt', 'two\n');
    expect(model.requests('main')).toHaveLength(4);
    expect(model.requests('main')[2]?.texts('user').some((text) => text.includes('Change a.txt.'))).toBe(false);
  },
);
