import { askUserQuestion, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });

selfTest('expectTranscript', {
  positive: {
    'finds a prompt and a reply from an earlier turn': {
      run: async ({ product, model }) => {
        model.script(say('An early answer.'), say('A later answer.'));
        await product.send('Ask early.');
        await product.waitIdle();
        await product.send('Ask later.');
        await product.waitIdle();
        await product.expectTranscript('Ask early.');
        await product.expectTranscript('An early answer.');
        await product.expectReply('A later answer.');
      },
    },
    'finds a reply that follows a tool call': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('The file says hello.'));
        await product.send('Read a.txt.');
        await product.waitIdle();
        await product.expectTranscript('The file says hello.');
      },
    },
  },
  negative: {
    'fails when the conversation never had the text': {
      run: async ({ product, model }) => {
        model.script(say('Only this answer.'));
        await product.send('Answer once.');
        await product.waitIdle();
        await expect(product.expectTranscript('An answer nobody gave.')).rejects.toThrow('did not find');
        await product.expectTranscript('Only this answer.');
      },
    },
    'fails when the text appears in two turns': {
      run: async ({ product, model }) => {
        model.script(say('A repeated answer.'), say('A repeated answer.'));
        await product.send('Answer the first time.');
        await product.waitIdle();
        await product.send('Answer the second time.');
        await product.waitIdle();
        await expect(product.expectTranscript('A repeated answer.')).rejects.toThrow('2 times');
        await product.expectReply('A repeated answer.');
      },
    },
    'does not take the answers a question collected for a message': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await product.answer('SQLite');
        await product.waitIdle();
        await expect(product.expectTranscript('SQLite')).rejects.toThrow('did not find');
        await expect(product.expectTranscript(QUESTION)).rejects.toThrow('did not find');
        await product.expectTranscript('Noted the choice.');
      },
    },
    'does not take a tool card for a message': {
      workspace: { 'notes-only.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('notes-only.txt'), say('Read it.'));
        await product.send('Read the notes.');
        await product.waitIdle();
        await expect(product.expectTranscript('notes-only.txt')).rejects.toThrow('did not find');
        await product.expectTranscript('Read it.');
      },
    },
  },
});
