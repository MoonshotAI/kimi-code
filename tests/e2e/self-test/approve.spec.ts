import { askUserQuestion, bash, edit, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });

selfTest('approve', {
  positive: {
    'approves a pending edit so the tool runs': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model, workspace }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('Edited b.txt.'));
        await product.send('Change old to new in b.txt.');
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
        await workspace.expectFile('b.txt', 'new\n');
      },
    },
    'approves a command for the session so the same command runs again without asking': {
      run: async ({ product, model, workspace }) => {
        const command = "printf 'x\\n' >> log.txt";
        model.script(bash(command), bash(command), say('Ran it twice.'));
        await product.send('Append x to log.txt twice.');
        await product.approve({ for: 'session' });
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(3);
        await product.expectReply('Ran it twice.');
        await workspace.expectFile('log.txt', 'x\nx\n');
      },
    },
  },
  negative: {
    'fails at once when a question is pending, not an approval': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await expect(product.approve()).rejects.toThrow('a question is pending');
        await product.answer('SQLite');
        await product.waitIdle();
        await product.expectReply('Noted the choice.');
      },
    },
    'fails when the turn ends without asking for approval': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I read a.txt.'));
        await product.send('Read a.txt.');
        await expect(product.approve()).rejects.toThrow('found no approval');
        await product.expectReply('I read a.txt.');
      },
    },
    'fails to approve for the session when the turn ends without asking for approval': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I read a.txt.'));
        await product.send('Read a.txt.');
        await expect(product.approve({ for: 'session' })).rejects.toThrow('found no approval');
        await product.expectReply('I read a.txt.');
      },
    },
  },
});
