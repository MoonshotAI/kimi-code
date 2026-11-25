import { bash, edit, read, say, write } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const COMMAND = "printf 'hi\\n' > hi.txt";

selfTest('expectApproval', {
  positive: {
    'finds a pending command with the whole command': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(COMMAND), say('Wrote hi.txt.'));
        await product.send('Write hi.txt with a shell command.');
        await product.expectApproval({ name: 'Bash', target: COMMAND });
        await product.approve();
        await product.waitIdle();
        await product.expectReply('Wrote hi.txt.');
        await workspace.expectFile('hi.txt', 'hi\n');
      },
    },
    'finds a pending edit and a pending write with their paths': {
      workspace: { 'docs/b.txt': 'old\n' },
      run: async ({ product, model, workspace }) => {
        model.script(edit({ path: 'docs/b.txt', old_string: 'old', new_string: 'new' }), write({ path: 'docs/c.md', content: '# C\n' }), say('Edited and wrote.'));
        await product.send('Update docs/b.txt and add docs/c.md.');
        await product.expectApproval({ name: 'Edit', target: 'docs/b.txt' });
        await product.approve();
        await product.expectApproval({ name: 'Write', target: 'docs/c.md' });
        await product.approve();
        await product.waitIdle();
        await product.expectReply('Edited and wrote.');
        await workspace.expectFile('docs/b.txt', 'new\n');
        await workspace.expectFile('docs/c.md', '# C\n');
      },
    },
  },
  negative: {
    'fails when the turn ends without asking for approval': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I read a.txt.'));
        await product.send('Read a.txt.');
        await expect(product.expectApproval({ name: 'Bash', target: 'cat a.txt' })).rejects.toThrow('found no approval');
        await product.expectReply('I read a.txt.');
      },
    },
    'fails when the approval is for another command': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(COMMAND), say('I did not write it.'));
        await product.send('Write hi.txt with a shell command.');
        await expect(product.expectApproval({ name: 'Bash', target: "printf 'bye\\n' > hi.txt" })).rejects.toThrow('does not show');
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: COMMAND, status: 'rejected' });
        await workspace.expectMissing('hi.txt');
      },
    },
    'fails when only the start of the command matches': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(COMMAND), say('I did not write it.'));
        await product.send('Write hi.txt with a shell command.');
        await expect(product.expectApproval({ name: 'Bash', target: "printf 'hi\\n'" })).rejects.toThrow('does not show');
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: COMMAND, status: 'rejected' });
        await workspace.expectMissing('hi.txt');
      },
    },
    'fails when the approval is for another tool on the same file': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('I left b.txt alone.'));
        await product.send('Change old to new in b.txt.');
        await expect(product.expectApproval({ name: 'Write', target: 'b.txt' })).rejects.toThrow('does not show');
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'rejected' });
      },
    },
    'fails when the file only shares its name with the expected one': {
      workspace: { 'docs/b.txt': 'old\n' },
      run: async ({ product, model }) => {
        model.script(edit({ path: 'docs/b.txt', old_string: 'old', new_string: 'new' }), say('I left docs/b.txt alone.'));
        await product.send('Change old to new in docs/b.txt.');
        await expect(product.expectApproval({ name: 'Edit', target: 'b.txt' })).rejects.toThrow('does not show');
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Edit', target: 'docs/b.txt', status: 'rejected' });
      },
    },
  },
});
