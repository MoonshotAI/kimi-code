import { bash, edit, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'asks only for what the chosen permission mode leaves to the user',
  { workspace: { 'n.txt': 'a\n', 'keep/k.txt': 'kept\n' } },
  async ({ product, model, workspace }) => {
    const routine = "printf 'y\\n' > y.txt";
    const another = "printf 'z\\n' > z.txt";
    const risky = 'rm -rf keep';

    await product.setPermissionMode('auto');
    model.script(edit({ path: 'n.txt', old_string: 'a', new_string: 'b' }), bash(routine), say('Done without asking.'));
    await product.send('Edit n.txt and write y.txt.');
    await product.waitIdle();
    expect(model.requests('main')).toHaveLength(3);
    await product.expectTool({ name: 'Edit', target: 'n.txt', status: 'done' });
    await product.expectTool({ name: 'Bash', target: routine, status: 'done' });
    await product.expectReply('Done without asking.');
    await workspace.expectFile('n.txt', 'b\n');
    await workspace.expectFile('y.txt', 'y\n');

    await product.setPermissionMode('yolo');
    model.script(bash(another), bash(risky), say('I kept the directory.'));
    await product.send('Write z.txt, then remove keep.');
    await product.expectApproval({ name: 'Bash', target: risky });
    await product.reject();
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests).toHaveLength(6);
    expect(requests[5]?.texts('tool').join('\n')).toContain('was not run because the user rejected the approval request.');
    await product.expectTool({ name: 'Bash', target: another, status: 'done' });
    await product.expectTool({ name: 'Bash', target: risky, status: 'rejected' });
    await product.expectReply('I kept the directory.');
    await workspace.expectFile('z.txt', 'z\n');
    await workspace.expectFile('keep/k.txt', 'kept\n');
  },
);
