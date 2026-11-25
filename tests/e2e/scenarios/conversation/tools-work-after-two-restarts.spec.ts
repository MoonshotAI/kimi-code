import { bash, edit, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'edits a file and runs a command as usual after the user restarts the product twice',
  { workspace: { 'notes.txt': 'draft\n' } },
  async ({ product, model, workspace }) => {
    const command = "printf 'shipped\\n' > status.txt";
    model.script(say('Ready when you are.'), edit({ path: 'notes.txt', old_string: 'draft', new_string: 'final' }), bash(command), say('Updated the notes and wrote the status.'));

    await product.send('Get ready to update the notes.');
    await product.waitIdle();
    await product.restart();
    await product.restart();
    await product.expectTranscript('Get ready to update the notes.');

    await product.send('Mark the notes final and record the status.');
    await product.expectApproval({ name: 'Edit', target: 'notes.txt' });
    await product.approve();
    await product.expectApproval({ name: 'Bash', target: command });
    await product.approve();
    await product.waitIdle();

    await product.expectTool({ name: 'Edit', target: 'notes.txt', status: 'done' });
    await product.expectTool({ name: 'Bash', target: command, status: 'done' });
    await product.expectReply('Updated the notes and wrote the status.');
    await workspace.expectFile('notes.txt', 'final\n');
    await workspace.expectFile('status.txt', 'shipped\n');
    expect(model.requests('main')[1]?.texts('user')).toContain('Get ready to update the notes.');
  },
);
