import { edit, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps the permission mode the user chose for a session after the user restarts the product',
  { workspace: { 'notes.txt': 'status: draft\n' } },
  async ({ product, model, workspace }) => {
    model.script(say('Noted.'), edit({ path: 'notes.txt', old_string: 'draft', new_string: 'final' }), say('Marked it final.'));

    await product.setPermissionMode('yolo');
    await product.send('Remember that edits are fine.');
    await product.waitIdle();

    await product.restart();
    await product.send('Mark notes.txt as final.');
    await product.waitIdle();

    await product.expectTool({ name: 'Edit', target: 'notes.txt', status: 'done' });
    await product.expectReply('Marked it final.');
    await workspace.expectFile('notes.txt', 'status: final\n');
    expect(model.requests('main')).toHaveLength(3);
  },
);
