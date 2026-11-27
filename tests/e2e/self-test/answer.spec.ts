import { askUserQuestion, bash, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });
const MARKER = "printf 'x\\n' > marker.txt";

selfTest('answer', {
  positive: {
    'picks an option and the model gets it as the answer': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await product.answer('SQLite');
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').map((text) => JSON.parse(text) as unknown)).toEqual([{ answers: { [QUESTION]: 'SQLite' } }]);
        await product.expectReply('Noted the choice.');
      },
    },
    'answers a question asked after another tool, whose group of tool calls folds as soon as the model replies': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), ASK, say('Noted the choice.'));
        await product.send('Read a.txt, then help me choose a database.');
        await product.answer('SQLite');
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(3);
        expect(JSON.parse(model.requests('main')[2]?.texts('tool').at(-1) ?? 'null')).toEqual({ answers: { [QUESTION]: 'SQLite' } });
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
        await expect(product.answer('SQLite')).rejects.toThrow('found no question: the turn ended');
        await product.expectReply('I read a.txt.');
      },
    },
    'fails without choosing anything when the question does not offer the option': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await expect(product.answer('MySQL')).rejects.toThrow('found no option "MySQL"');
        await product.answer('Postgres');
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').map((text) => JSON.parse(text) as unknown)).toEqual([{ answers: { [QUESTION]: 'Postgres' } }]);
        await product.expectReply('Noted the choice.');
      },
    },
    'fails at once when an approval is pending, not a question': {
      run: async ({ product, model, workspace }) => {
        model.script(bash(MARKER), say('I did not write it.'));
        await product.send('Write the marker.');
        await expect(product.answer('SQLite')).rejects.toThrow('an approval is pending');
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: MARKER, status: 'rejected' });
        await workspace.expectMissing('marker.txt');
      },
    },
    'fails when the model asks several questions at once': {
      run: async ({ product, model }) => {
        model.script(
          askUserQuestion({
            questions: [
              { question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false },
              { question: 'Which cache should we use?', header: 'Cache', options: [{ label: 'Redis' }, { label: 'None' }], multi_select: false },
            ],
          }),
          say('I will decide later.'),
        );
        await product.send('Help me set up storage.');
        await expect(product.answer('SQLite')).rejects.toThrow('one question at a time');
        await product.dismissQuestion();
        await product.waitIdle();
        await product.expectReply('I will decide later.');
      },
    },
  },
});
