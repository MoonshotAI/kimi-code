import { edit, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'shows what an edit will change before the user approves it, and leaves the file alone until then',
  { workspace: { 'notes/n.txt': 'title: launch\nstatus: draft\nowner: ops\n' } },
  async ({ product, model, workspace }) => {
    model.script(edit({ path: 'notes/n.txt', old_string: 'status: draft', new_string: 'status: final\nreviewed: yes' }), say('Marked n.txt as final.'));

    await product.send('Mark n.txt as final and reviewed.');
    await product.expectApproval({ name: 'Edit', target: 'notes/n.txt', added: ['status: final', 'reviewed: yes'], removed: ['status: draft'] });
    await workspace.expectFile('notes/n.txt', 'title: launch\nstatus: draft\nowner: ops\n');
    await product.approve();
    await product.waitIdle();

    expect(model.requests('main')).toHaveLength(2);
    await product.expectTool({ name: 'Edit', target: 'notes/n.txt', status: 'done' });
    await product.expectReply('Marked n.txt as final.');
    await workspace.expectFile('notes/n.txt', 'title: launch\nstatus: final\nreviewed: yes\nowner: ops\n');
  },
);
