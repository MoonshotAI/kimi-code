import { bash, edit, say, write } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'shows the whole command and the files before the user approves them',
  { workspace: { 'notes/n.txt': 'status: draft\n' } },
  async ({ product, model, workspace }) => {
    const command = "printf 'a line long enough to need more than fifty characters\\n' >> notes/log.txt";
    model.script(
      bash(command),
      edit({ path: 'notes/n.txt', old_string: 'draft', new_string: 'final' }),
      write({ path: 'notes/d.md', content: '# Draft\n' }),
      say('Logged, finished n.txt and added d.md.'),
    );

    await product.send('Log a line, finish n.txt and add d.md.');
    await product.expectApproval({ name: 'Bash', target: command });
    await product.approve();
    await product.expectApproval({ name: 'Edit', target: 'notes/n.txt' });
    await product.approve();
    await product.expectApproval({ name: 'Write', target: 'notes/d.md' });
    await product.approve();
    await product.waitIdle();

    expect(model.requests('main')).toHaveLength(4);
    await product.expectTool({ name: 'Bash', target: command, status: 'done' });
    await product.expectTool({ name: 'Edit', target: 'notes/n.txt', status: 'done' });
    await product.expectTool({ name: 'Write', target: 'notes/d.md', status: 'done' });
    await product.expectReply('Logged, finished n.txt and added d.md.');
    await workspace.expectFile('notes/log.txt', 'a line long enough to need more than fifty characters\n');
    await workspace.expectFile('notes/n.txt', 'status: final\n');
    await workspace.expectFile('notes/d.md', '# Draft\n');
  },
);
