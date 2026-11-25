import { askUserQuestion, bash, edit, held, httpError, read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest, selfTestCase } from '../support/scenario';

const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });
const NO_QUEUE_ON_ACP = 'ACP has no way to send a message while a turn runs, so nothing ever waits in a queue there.';

selfTest('waitIdle', {
  positive: {
    'returns once a turn has completed': {
      run: async ({ product, model }) => {
        model.script(say('All done.'));
        await product.send('Finish a turn.');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.state)).toEqual(['finished']);
        await product.expectReply('All done.');
      },
    },
    'keeps following a conversation that mentions a process exit status': {
      run: async ({ product, model }) => {
        model.script(say('The shell printed E2E_CLI_EXIT=0 at the end.'), say('Still running.'));
        await product.send('Explain what E2E_CLI_EXIT=0 means.');
        await product.waitIdle();
        await product.expectReply('The shell printed E2E_CLI_EXIT=0 at the end.');
        await product.send('Are you still running?');
        await product.waitIdle();
        await product.expectReply('Still running.');
      },
    },
    'returns after a reply whose line starts with a moon emoji': {
      run: async ({ product, model }) => {
        model.script(say('Moon phases:\n\n🌕 Full moon tonight.'));
        await product.send('Tell me the moon phase.');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.state)).toEqual(['finished']);
        await product.expectReply('Full moon tonight.');
      },
    },
    'returns only after the messages queued during the turn have run': selfTestCase({ except: { acp: NO_QUEUE_ON_ACP } }, async ({ product, model }) => {
      const order: string[] = [];
      model.script(held('first', say(['Working on the ', 'first answer.']), 1), held('queued', say('Queued message answered.')));
      await product.send('Start the first answer.');
      await model.hold('first').reached();
      await product.queue('Then answer this.');
      const idle = product.waitIdle().then(() => order.push('returned'));
      model.hold('first').release();
      await model.hold('queued').reached();
      order.push('released');
      model.hold('queued').release();
      await idle;
      expect(order).toEqual(['released', 'returned']);
      expect(model.requests('main').map((request) => request.state)).toEqual(['finished', 'finished']);
      await product.expectReply('Queued message answered.');
    }),
    'returns once a turn has failed, without judging it': {
      run: async ({ product, model }) => {
        model.script(httpError(400), say('Recovered.'));
        await product.send('Trigger a model failure.');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.state)).toEqual(['failed']);
        await product.send('Try again.');
        await product.waitIdle();
        await product.expectReply('Recovered.');
      },
    },
    'returns once the model service refused the request, without judging the turn': {
      run: async ({ product, model }) => {
        model.script(httpError(401), say('Recovered.'));
        await product.send('Trigger an authentication failure.');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.state)).toEqual(['failed']);
        await product.send('Try again.');
        await product.waitIdle();
        await product.expectReply('Recovered.');
      },
    },
    'returns once a command has finished, even though it left a process running in the background': {
      workspace: { 'linger.sh': 'here=$PWD\nfor tick in $(seq 1 300); do [ -d "$here" ] || exit 0; sleep 1; done\n' },
      run: async ({ product, model }) => {
        const command = 'sh linger.sh > /dev/null 2>&1 & echo started | tee /dev/null';
        model.script(bash(command), say('Started it.'));
        await product.send('Start something in the background.');
        await product.approve();
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain('started');
        await product.expectTool({ name: 'Bash', target: command, status: 'done' });
        await product.expectReply('Started it.');
      },
    },
  },
  negative: {
    'fails at once when a question is pending, not an approval': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await expect(product.waitIdle()).rejects.toThrow('a question is pending');
        await product.answer('SQLite');
        await product.waitIdle();
        await product.expectReply('Noted the choice.');
      },
    },
    'does not return while the model is still replying': {
      run: async ({ product, model }) => {
        const order: string[] = [];
        model.script(held('reply', say('Finished late.')));
        await product.send('Reply late.');
        const idle = product.waitIdle().then(() => order.push('returned'));
        await model.hold('reply').reached();
        order.push('released');
        model.hold('reply').release();
        await idle;
        expect(order).toEqual(['released', 'returned']);
        await product.expectReply('Finished late.');
      },
    },
    'does not take reply text that looks like a failed turn for the end of the turn': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        const prompt = 'Quote the log, then answer.';
        model.script(
          read('a.txt', { text: 'Quoting the log:\n\nError: [example] this line is part of the reply.' }),
          held('answer', say('Final answer.')),
        );
        await product.send(prompt);
        await model.hold('answer').reached();
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await expect(product.send('Second prompt.')).rejects.toThrow('needs an idle product');
        model.hold('answer').release();
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.firstUserText)).toEqual([prompt, prompt]);
        await product.expectReply('Final answer.');
      },
    },
    'fails when an approval is still pending': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model, workspace }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('Edited b.txt.'));
        await product.send('Change old to new in b.txt.');
        await expect(product.waitIdle()).rejects.toThrow('found a pending approval');
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
        await workspace.expectFile('b.txt', 'new\n');
      },
    },
  },
});
