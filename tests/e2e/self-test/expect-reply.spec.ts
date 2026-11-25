import { askUserQuestion, held, httpError, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest, selfTestCase } from '../support/scenario';

const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });
const ONE_PROMPT_AT_A_TIME_ON_ACP = 'ACP has no way to send a message while a turn runs, so a turn there never holds more than one user message.';

selfTest('expectReply', {
  positive: {
    'finds text once in this turn even though an earlier turn said it too': {
      run: async ({ product, model }) => {
        model.script(say('Same answer as before.'), say('Same answer as before.'));
        await product.send('Answer once.');
        await product.waitIdle();
        await product.expectReply('Same answer as before.');
        await product.send('Answer again.');
        await product.waitIdle();
        await product.expectReply('Same answer as before.');
      },
    },
    'finds the text the assistant replied with': {
      run: async ({ product, model }) => {
        model.script(say('The sky is blue.'));
        await product.send('What colour is the sky?');
        await product.waitIdle();
        await product.expectReply('The sky is blue.');
      },
    },
    'finds text in a later paragraph of the reply': {
      run: async ({ product, model }) => {
        model.script(say('The first paragraph.\n\nThe second paragraph.'));
        await product.send('Answer in two paragraphs.');
        await product.waitIdle();
        await product.expectReply('The first paragraph.');
        await product.expectReply('The second paragraph.');
      },
    },
    'finds a reply whose first words read like the start of a tool card': {
      run: async ({ product, model }) => {
        model.script(say('Used the cached answer because nothing changed.'), say('Read 2 files and found nothing new.'));
        await product.send('Answer from the cache.');
        await product.waitIdle();
        await product.expectReply('Used the cached answer because nothing changed.');
        await product.send('Summarise what you read.');
        await product.waitIdle();
        await product.expectReply('Read 2 files and found nothing new.');
      },
    },
    'finds text after a line of the reply that quotes a prompt marker': {
      run: async ({ product, model }) => {
        model.script(say('Terminal transcript:\n\n❯ echo one\n\nThe command printed one line.'));
        await product.send('Show me a terminal transcript.');
        await product.waitIdle();
        await product.expectReply('Terminal transcript:');
        await product.expectReply('The command printed one line.');
      },
    },
    'finds text in and around a bullet list in the reply': {
      run: async ({ product, model }) => {
        model.script(say('The plan has two steps:\n\n- gather the facts\n- write them down\n\nThat is the whole plan.'));
        await product.send('Give me a plan as a list.');
        await product.waitIdle();
        await product.expectReply('The plan has two steps:');
        await product.expectReply('write them down');
        await product.expectReply('That is the whole plan.');
      },
    },
    'finds text after a horizontal rule in the reply': {
      run: async ({ product, model }) => {
        model.script(say('First section.\n\n---\n\nSecond section.'));
        await product.send('Answer in two sections.');
        await product.waitIdle();
        await product.expectReply('First section.');
        await product.expectReply('Second section.');
      },
    },
  },
  negative: {
    'does not take the message of a failed turn for a reply': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt', { text: 'Looking at the file now.' }), httpError(400, { message: 'the gateway refused this request' }));
        await product.send('Read a.txt for me.');
        await product.waitIdle();
        await expect(product.expectReply('the gateway refused this request')).rejects.toThrow('did not find');
        await product.expectError('the gateway refused this request');
        await product.expectReply('Looking at the file now.');
      },
    },
    'fails when the text appears twice in the replies of this turn': {
      run: async ({ product, model }) => {
        model.script(say('Ready now. Ready now.'));
        await product.send('Say you are ready, twice.');
        await product.waitIdle();
        await expect(product.expectReply('Ready now.')).rejects.toThrow('2 times');
        await product.expectReply('Ready now. Ready now.');
      },
    },
    'fails when the text appears once before a tool call and once after it': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt', { text: 'Checking the file.' }), say('Checking the file. It says hello.'));
        await product.send('Check a.txt and say what it holds.');
        await product.waitIdle();
        await expect(product.expectReply('Checking the file.')).rejects.toThrow('2 times');
        await product.expectReply('It says hello.');
      },
    },
    'fails when the assistant replied with something else': {
      run: async ({ product, model }) => {
        model.script(say('The grass is green.'));
        await product.send('What colour is the sky?');
        await product.waitIdle();
        await expect(product.expectReply('The sky is blue.')).rejects.toThrow('did not find "The sky is blue."');
        await product.expectReply('The grass is green.');
      },
    },
    'does not join the words before a tool call with the words after it': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt', { text: 'Before the tool.' }), say('After the tool.'));
        await product.send('Say something, read a.txt, then say something else.');
        await product.waitIdle();
        await expect(product.expectReply('Before the tool.After the tool.')).rejects.toThrow('did not find "Before the tool.After the tool."');
        await product.expectReply('Before the tool.');
        await product.expectReply('After the tool.');
      },
    },
    'does not take the answers a question collected for a reply': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await product.answer('SQLite');
        await product.waitIdle();
        await expect(product.expectReply('SQLite')).rejects.toThrow('did not find "SQLite"');
        await expect(product.expectReply(QUESTION)).rejects.toThrow(`did not find "${QUESTION}"`);
        await expect(product.expectReply('Collected your answers')).rejects.toThrow('did not find "Collected your answers"');
        await product.expectReply('Noted the choice.');
      },
    },
    'does not take the note of a dismissed question for a reply': {
      run: async ({ product, model }) => {
        model.script(ASK, say('I will pick one myself.'));
        await product.send('Help me choose a database.');
        await product.dismissQuestion();
        await product.waitIdle();
        await expect(product.expectReply('dismissed the question')).rejects.toThrow('did not find "dismissed the question"');
        await expect(product.expectReply(QUESTION)).rejects.toThrow(`did not find "${QUESTION}"`);
        await product.expectReply('I will pick one myself.');
      },
    },
    'does not take a tool card for a reply': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I looked at the file.'));
        await product.send('Look at the file.');
        await product.waitIdle();
        await expect(product.expectReply('Used Read (a.txt)')).rejects.toThrow('did not find "Used Read (a.txt)"');
        await expect(product.expectReply('a.txt')).rejects.toThrow('did not find "a.txt"');
        await product.expectReply('I looked at the file.');
      },
    },
    'does not take a reply from an earlier turn': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'));
        await product.send('Ask once.');
        await product.waitIdle();
        await product.expectReply('The first answer.');
        await product.send('Ask again.');
        await product.waitIdle();
        await expect(product.expectReply('The first answer.')).rejects.toThrow('did not find "The first answer."');
        await product.expectReply('The second answer.');
      },
    },
    'does not take a reply that came before a steered message': selfTestCase({ except: { acp: ONE_PROMPT_AT_A_TIME_ON_ACP } }, async ({ product, model }) => {
      model.script(held('drafting', say(['Drafting the ', 'notes now.']), 1), say('Switched to the release profile.'));
      await product.send('Draft the release notes.');
      await model.hold('drafting').reached();
      await product.expectReply('Drafting the');
      await product.steer('Use the release profile.');
      await product.waitIdle();
      await expect(product.expectReply('Drafting the')).rejects.toThrow('did not find "Drafting the"');
      await product.expectReply('Switched to the release profile.');
    }),
    'does not take the reply to an earlier queued message': selfTestCase({ except: { acp: ONE_PROMPT_AT_A_TIME_ON_ACP } }, async ({ product, model }) => {
      model.script(held('first', say(['Working on the ', 'first answer.']), 1), say('The earlier queued answer.'), say('The later queued answer.'));
      await product.send('Start the first answer.');
      await model.hold('first').reached();
      await product.queue('Answer the earlier queued message.');
      await product.queue('Answer the later queued message.');
      model.hold('first').release();
      await product.waitIdle();
      await expect(product.expectReply('The earlier queued answer.')).rejects.toThrow('did not find "The earlier queued answer."');
      await product.expectReply('The later queued answer.');
    }),
    'does not take the prompt the user typed for a reply': {
      run: async ({ product, model }) => {
        model.script(say('Noted.'));
        await product.send('Repeat after me: the sky is blue.');
        await product.waitIdle();
        await expect(product.expectReply('the sky is blue')).rejects.toThrow('did not find "the sky is blue"');
        await product.expectReply('Noted.');
      },
    },
  },
});
