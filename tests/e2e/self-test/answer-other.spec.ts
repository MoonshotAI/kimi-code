import { askUserQuestion, bash, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });
const MARKER = "printf 'x\\n' > marker.txt";

selfTest('answerOther', {
  positive: {
    'types an answer of their own and the model gets it word for word': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await product.answerOther('Whatever the team already runs');
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').map((text) => JSON.parse(text) as unknown)).toEqual([{ answers: { [QUESTION]: 'Whatever the team already runs' } }]);
        await product.expectReply('Noted the choice.');
      },
    },
    'types an answer to a question asked after another tool, whose group of tool calls folds as soon as the model replies': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), ASK, say('Noted the choice.'));
        await product.send('Read a.txt, then help me choose a database.');
        await product.answerOther('Whatever the team already runs');
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(3);
        expect(JSON.parse(model.requests('main')[2]?.texts('tool').at(-1) ?? 'null')).toEqual({ answers: { [QUESTION]: 'Whatever the team already runs' } });
        await product.expectReply('Noted the choice.');
      },
    },
  },
  negative: {
    'fails when the turn ends without asking a question': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I read a.txt.'));
        await product.send('Read a.txt.');
        await expect(product.answerOther('Anything')).rejects.toThrow('found no question: the turn ended');
        await product.expectReply('I read a.txt.');
      },
    },
    'fails at once when an approval is pending, not a question': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(MARKER), say('I did not write it.'));
        await product.send('Write the marker.');
        await expect(product.answerOther('Anything')).rejects.toThrow('an approval is pending');
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: MARKER, status: 'rejected' });
        await workspace.expectMissing('marker.txt');
      },
    },
  },
});
