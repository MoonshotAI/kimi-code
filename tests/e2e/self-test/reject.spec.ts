import { askUserQuestion, edit, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });

selfTest('reject', {
  positive: {
    'rejects a pending edit so the tool does not run': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('I left b.txt alone.'));
        await product.send('Change old to new in b.txt.');
        await product.reject();
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain('was not run because the user rejected the approval request.');
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'rejected' });
        await product.expectReply('I left b.txt alone.');
      },
    },
  },
  negative: {
    'fails at once when a question is pending, not an approval': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await expect(product.reject()).rejects.toThrow('a question is pending');
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
        await expect(product.reject()).rejects.toThrow('found no approval');
        await product.expectReply('I read a.txt.');
      },
    },
  },
});
