import { askUserQuestion, bash, edit, held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const ANSWER_FIRST_ON_TUI = 'The terminal UI has no way to stop a turn without answering its approval: Esc, Ctrl+C and Ctrl+D on the approval panel reject it.';
const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });
const MARKER = "printf 'x\\n' > marker.txt";

const NO_LIVE_OUTPUT = "Product gap, left out until the owner decides: the agent sends a command's output to an editor that offers no terminals only once the command ends, so such an editor cannot show what a running command has printed.";

selfTest('stop', {
  positive: {
    'stops a turn that is still streaming its reply': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model }) => {
        model.script(held('mid-reply', edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }, { text: 'Let me update b.txt.' }), 1));
        await product.send('Update b.txt.');
        await model.hold('mid-reply').reached();
        await product.expectReply('Let me update b.txt.');
        await product.stop();
        await product.waitIdle();
        model.hold('mid-reply').release();
        expect(model.requests('main').map((request) => request.state)).toEqual(['aborted']);
      },
    },
    'stops a command that is running and has already printed, and takes the next message': {
      exceptVariants: { 'bare-editor': NO_LIVE_OUTPUT },
      run: async ({ product, model }) => {
        const command = "printf 'rea%s\\n' dy; sleep 30";
        model.script(bash(command), say('The command was stopped.'));
        await product.send('Print one word, then wait.');
        await product.approve();
        await product.expectTool({ name: 'Bash', target: command, status: 'running', output: 'ready' });
        await product.stop();
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(1);
        await product.send('What happened to the command?');
        await product.waitIdle();
        await product.expectReply('The command was stopped.');
      },
    },
    'stops a turn while a command waits for approval, so the command never runs': {
      except: { tui: ANSWER_FIRST_ON_TUI },
      run: async ({ product, model, workspace }) => {
        model.script(bash(MARKER));
        await product.send('Write the marker.');
        await product.expectApproval({ name: 'Bash', target: MARKER });
        await product.stop();
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(1);
        await product.expectTool({ name: 'Bash', target: MARKER, status: 'failed' });
        await workspace.expectMissing('marker.txt');
        model.script(say('Ready again.'));
        await product.send('Are you there?');
        await product.waitIdle();
        await product.expectReply('Ready again.');
      },
    },
  },
  negative: {
    'fails while a question is pending, since no surface stops a turn without answering it': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await expect(product.waitIdle()).rejects.toThrow('a question is pending');
        await expect(product.stop()).rejects.toThrow('a question is pending');
        await product.answer('SQLite');
        await product.waitIdle();
        await product.expectReply('Noted the choice.');
      },
    },
    'fails when no turn is running': {
      run: async ({ product, model }) => {
        await expect(product.stop()).rejects.toThrow('needs a running turn');
        model.script(say('Nothing was stopped.'));
        await product.send('Did anything stop?');
        await product.waitIdle();
        await expect(product.stop()).rejects.toThrow('needs a running turn');
        await product.expectReply('Nothing was stopped.');
      },
    },
    'fails on the terminal UI while an approval is pending': {
      onlyOn: ['tui'],
      reason: 'Only the terminal UI has no way to stop a turn without answering its approval; on the other surfaces stop() stops it.',
      run: async ({ product, model, workspace }) => {
        model.script(bash(MARKER), say('I did not write it.'));
        await product.send('Write the marker.');
        await product.expectApproval({ name: 'Bash', target: MARKER });
        await expect(product.stop()).rejects.toThrow('without answering');
        await product.reject();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: MARKER, status: 'rejected' });
        await workspace.expectMissing('marker.txt');
      },
    },
  },
});
