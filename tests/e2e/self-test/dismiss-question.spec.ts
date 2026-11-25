import { askUserQuestion, bash, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });
const MARKER = "printf 'x\\n' > marker.txt";

selfTest('dismissQuestion', {
  positive: {
    'closes the question without an answer and the model is told so': {
      run: async ({ product, model }) => {
        model.script(ASK, say('I will pick one myself.'));
        await product.send('Help me choose a database.');
        await product.dismissQuestion();
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').map((text) => JSON.parse(text) as unknown)).toEqual([
          { answers: {}, note: 'User dismissed the question without answering.' },
        ]);
        await product.expectReply('I will pick one myself.');
      },
    },
  },
  negative: {
    'fails when the turn ends without asking a question': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I read a.txt.'));
        await product.send('Read a.txt.');
        await expect(product.dismissQuestion()).rejects.toThrow('found no question: the turn ended');
        await product.expectReply('I read a.txt.');
      },
    },
    'fails at once when an approval is pending, not a question': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(MARKER), say('I did not write it.'));
        await product.send('Write the marker.');
        await expect(product.dismissQuestion()).rejects.toThrow('an approval is pending');
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: MARKER, status: 'rejected' });
        await workspace.expectMissing('marker.txt');
      },
    },
  },
});
