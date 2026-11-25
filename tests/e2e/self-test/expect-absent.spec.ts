import { askUserQuestion, held, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });

selfTest('expectAbsent', {
  positive: {
    'passes when the replies of the latest turn never said the text': {
      run: async ({ product, model }) => {
        model.script(say('The grass is green.'));
        await product.send('What colour is the grass?');
        await product.waitIdle();
        await product.expectAbsent('The sky is blue.');
        await product.expectReply('The grass is green.');
      },
    },
    'passes when only an earlier turn said the text': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'));
        await product.send('Ask once.');
        await product.waitIdle();
        await product.send('Ask again.');
        await product.waitIdle();
        await product.expectAbsent('The first answer.');
        await product.expectReply('The second answer.');
      },
    },
    'does not read the prompt the user typed or a tool card': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('Noted.'));
        await product.send('Read a.txt and repeat after me: the sky is blue.');
        await product.waitIdle();
        await product.expectAbsent('the sky is blue');
        await product.expectAbsent('a.txt');
        await product.expectReply('Noted.');
      },
    },
    'does not read the answers a question collected': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await product.answer('SQLite');
        await product.waitIdle();
        await product.expectAbsent('SQLite');
        await product.expectAbsent(QUESTION);
        await product.expectReply('Noted the choice.');
      },
    },
  },
  negative: {
    'fails when a reply of the latest turn said the text': {
      run: async ({ product, model }) => {
        model.script(say('The sky is blue.'));
        await product.send('What colour is the sky?');
        await product.waitIdle();
        await expect(product.expectAbsent('sky is blue')).rejects.toThrow('found "sky is blue"');
        await product.expectReply('The sky is blue.');
      },
    },
    'fails when the words before a tool call said the text': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt', { text: 'Before the tool.' }), say('After the tool.'));
        await product.send('Say something, read a.txt, then say something else.');
        await product.waitIdle();
        await expect(product.expectAbsent('Before the tool.')).rejects.toThrow('found "Before the tool."');
        await product.expectReply('After the tool.');
      },
    },
    'fails while a turn is still running': {
      run: async ({ product, model }) => {
        model.script(held('reply', say('Finished late.')));
        await product.send('Reply late.');
        await model.hold('reply').reached();
        await expect(product.expectAbsent('Finished late.')).rejects.toThrow('needs an idle product');
        model.hold('reply').release();
        await product.waitIdle();
        await product.expectReply('Finished late.');
      },
    },
  },
});
