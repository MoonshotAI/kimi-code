import { askUserQuestion, bash, batch, edit, held, read, say, waitFor, write } from '@moonshot-ai/testkit/model';

import { expect, selfTest, selfTestCase } from '../support/scenario';

const PRINT_READY = "printf 'rea%s\\n' dy";
const PRINT_TWO_LINES_THEN_WAIT = `printf 'st%s\\n' art; ${PRINT_READY}; sleep 30`;

const GATED_BUILD = "printf 'rea%s\\n' dy; while [ ! -f gate.txt ]; do sleep 0.1; done; printf 'don%s\\n' e";
const LONG_BUILD = "printf 'rea%s\\n' dy; sleep 300";
const TWO_WAITS = [
  bash({ command: GATED_BUILD, description: 'Run the slow build', run_in_background: true }),
  waitFor({ timeout: 1 }),
  waitFor({ timeout: 90 }),
  held('reported', say('The build finished.')),
] as const;
const ONLY_OVER_ACP = {
  tui: 'This case waits for the usage updates that only an ACP editor receives; the case before it covers the other surfaces.',
  desktop: 'This case waits for the usage updates that only an ACP editor receives; the case before it covers the other surfaces.',
  web: 'This case waits for the usage updates that only an ACP editor receives; the case before it covers the other surfaces.',
};
const FINISHED_WAIT_ON_ACP =
  'When the wait sees its task finish, the agent ends the turn and answers in a turn it starts on its own; an ACP editor sees no start of that turn, so the steps cannot wait for its reply.';
const NO_STEER_ON_ACP = 'ACP has no way to send a message while a turn runs, so nothing can interrupt the wait there.';
const QUESTION = 'Which database should we use?';
const ASK = askUserQuestion({ questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] });
const DISMISSED_WITHOUT_QUESTION_ON_TUI = 'The terminal UI shows a dismissed question only as dismissed, without the question it asked.';

selfTest('expectTool', {
  positive: {
    'finds a wait that timed out, then one that saw its task finish': selfTestCase({ except: { acp: FINISHED_WAIT_ON_ACP } }, async ({ product, model, workspace }) => {
      model.script(...TWO_WAITS);
      await product.send('Run the slow build and wait for it.');
      await product.approve();
      await product.expectTool({ name: 'WaitFor', status: 'done', outcome: 'timed out' });
      await product.expectTool({ name: 'WaitFor', status: 'running' });
      await workspace.write('gate.txt', '');
      await model.hold('reported').reached();
      model.hold('reported').release();
      await product.waitIdle();
      await product.expectReply('The build finished.');
      await product.expectTool({ name: 'WaitFor', status: 'done', outcome: 'finished' });
    }),
    'finds a wait that timed out, then one that saw its task finish, over ACP': selfTestCase({ except: ONLY_OVER_ACP }, async ({ product, model, workspace }) => {
      model.script(...TWO_WAITS);
      await product.send('Run the slow build and wait for it.');
      await product.approve();
      await product.expectTool({ name: 'WaitFor', status: 'done', outcome: 'timed out' });
      await product.expectTool({ name: 'WaitFor', status: 'running' });
      await workspace.write('gate.txt', '');
      await model.hold('reported').reached();
      model.hold('reported').release();
      await product.waitForUsageUpdates(2);
      await product.expectTool({ name: 'WaitFor', status: 'done', outcome: 'finished' });
      await product.expectTranscript('The build finished.');
    }),
    'finds a wait that new input interrupted, before the message that interrupted it': selfTestCase({ except: { acp: NO_STEER_ON_ACP } }, async ({ product, model }) => {
      model.script(bash({ command: LONG_BUILD, description: 'Run the long build', run_in_background: true }), waitFor({ timeout: 90 }), say('Looking at the logs.'));
      await product.send('Run the long build and wait for it.');
      await product.approve();
      await product.expectTool({ name: 'WaitFor', status: 'running' });
      await product.steer('Look at the logs instead.');
      await product.waitIdle();
      await product.expectReply('Looking at the logs.');
      await product.expectTool({ name: 'WaitFor', status: 'done', outcome: 'interrupted' });
    }),
    'finds a completed edit by name, target and status': {
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
    'finds each file among several reads made in one step': {
      workspace: { 'a.txt': 'hello\n', 'b.txt': 'world\n' },
      run: async ({ product, model }) => {
        model.script(batch(read('a.txt'), read('b.txt')), say('I read both files.'));
        await product.send('Read a.txt and b.txt.');
        await product.waitIdle();
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await product.expectTool({ name: 'Read', target: 'b.txt', status: 'done' });
        await product.expectReply('I read both files.');
      },
    },
    'finds a shell command that ran after approval': {
      run: async ({ product, model, workspace }) => {
        model.script(bash('echo hi | tee out.txt'), say('Created out.txt.'));
        await product.send('Write hi into out.txt with a shell command.');
        await product.approve();
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').join('\n')).toMatch(/(^|\n)hi\n/);
        await product.expectTool({ name: 'Bash', target: 'echo hi | tee out.txt', status: 'done' });
        await workspace.expectFile('out.txt', 'hi\n');
      },
    },
    'finds a write whose file a later step of the same turn changed again': {
      run: async ({ product, model, workspace }) => {
        model.script(write({ path: 'b.txt', content: 'one\n' }), bash('echo two >> b.txt'), say('Wrote b.txt twice.'));
        await product.send('Write one into b.txt, then append two with a shell command.');
        await product.approve();
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Write', target: 'b.txt', status: 'done' });
        await product.expectTool({ name: 'Bash', target: 'echo two >> b.txt', status: 'done' });
        await workspace.expectFile('b.txt', 'one\ntwo\n');
      },
    },
    'finds a shell command that failed before it could start': {
      run: async ({ product, model }) => {
        model.script(bash({ command: 'echo never', run_in_background: true }), say('It did not start.'));
        await product.send('Start a background command without describing it.');
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: 'echo never', status: 'failed' });
        await product.expectReply('It did not start.');
      },
    },
    'reports a command that the user stopped as failed': {
      run: async ({ product, model }) => {
        model.script(bash('sleep 20'));
        await product.send('Run a slow command.');
        await product.approve();
        await product.stop();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: 'sleep 20', status: 'failed' });
        expect(model.requests('main')).toHaveLength(1);
      },
    },
    'finds what a finished command printed, and finds the command again without asking for its output': {
      run: async ({ product, model }) => {
        model.script(bash(PRINT_READY), say('It printed one word.'));
        await product.send('Print one word with a shell command.');
        await product.approve();
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').join('\n')).toMatch(/(^|\n)ready\n/);
        await product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'ready' });
        await product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done' });
      },
    },
    'finds the latest line a running command has printed, and both lines after the user stopped the command': {
      run: async ({ product, model }) => {
        model.script(bash(PRINT_TWO_LINES_THEN_WAIT));
        await product.send('Print two words, then wait.');
        await product.approve();
        await product.expectTool({ name: 'Bash', target: PRINT_TWO_LINES_THEN_WAIT, status: 'running', output: 'ready' });
        await product.stop();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: PRINT_TWO_LINES_THEN_WAIT, status: 'failed', output: 'start' });
        await product.expectTool({ name: 'Bash', target: PRINT_TWO_LINES_THEN_WAIT, status: 'failed', output: 'ready' });
        expect(model.requests('main')).toHaveLength(1);
      },
    },
    'finds an answered question by the question it asked': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await product.answer('SQLite');
        await product.waitIdle();
        await product.expectTool({ name: 'AskUserQuestion', target: QUESTION, status: 'done' });
        await product.expectReply('Noted the choice.');
      },
    },
    'finds a dismissed question by the question it asked': {
      except: { tui: DISMISSED_WITHOUT_QUESTION_ON_TUI },
      run: async ({ product, model }) => {
        model.script(ASK, say('I will pick one myself.'));
        await product.send('Help me choose a database.');
        await product.dismissQuestion();
        await product.waitIdle();
        await product.expectTool({ name: 'AskUserQuestion', target: QUESTION, status: 'done' });
        await product.expectReply('I will pick one myself.');
      },
    },
  },
  negative: {
    'fails when the wait is over, or ended in another way': selfTestCase({ except: { acp: FINISHED_WAIT_ON_ACP } }, async ({ product, model, workspace }) => {
      model.script(...TWO_WAITS);
      await product.send('Run the slow build and wait for it.');
      await product.approve();
      await product.expectTool({ name: 'WaitFor', status: 'running' });
      await expect(product.expectTool({ name: 'WaitFor', status: 'done', outcome: 'interrupted' })).rejects.toThrow('WaitFor that ended interrupted');
      await workspace.write('gate.txt', '');
      await model.hold('reported').reached();
      model.hold('reported').release();
      await product.waitIdle();
      await product.expectReply('The build finished.');
      await expect(product.expectTool({ name: 'WaitFor', status: 'running' })).rejects.toThrow('WaitFor still waiting');
    }),
    'fails when the wait is over, or ended in another way, over ACP': selfTestCase({ except: ONLY_OVER_ACP }, async ({ product, model, workspace }) => {
      model.script(...TWO_WAITS);
      await product.send('Run the slow build and wait for it.');
      await product.approve();
      await product.expectTool({ name: 'WaitFor', status: 'running' });
      await expect(product.expectTool({ name: 'WaitFor', status: 'done', outcome: 'interrupted' })).rejects.toThrow('WaitFor that ended interrupted');
      await workspace.write('gate.txt', '');
      await model.hold('reported').reached();
      model.hold('reported').release();
      await product.waitForUsageUpdates(2);
      await expect(product.expectTool({ name: 'WaitFor', status: 'running' })).rejects.toThrow('WaitFor still waiting');
      await product.expectTranscript('The build finished.');
    }),
    'fails when the question asked was a different one': {
      run: async ({ product, model }) => {
        model.script(ASK, say('Noted the choice.'));
        await product.send('Help me choose a database.');
        await product.answer('SQLite');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'AskUserQuestion', target: 'Which cache should we use?', status: 'done' })).rejects.toThrow('did not find AskUserQuestion');
        await expect(product.expectTool({ name: 'AskUserQuestion', target: 'SQLite', status: 'done' })).rejects.toThrow('did not find AskUserQuestion');
        await product.expectReply('Noted the choice.');
      },
    },
    'fails on the terminal UI for a dismissed question, whose card does not show the question': {
      onlyOn: ['tui'],
      reason: DISMISSED_WITHOUT_QUESTION_ON_TUI,
      run: async ({ product, model }) => {
        model.script(ASK, say('I will pick one myself.'));
        await product.send('Help me choose a database.');
        await product.dismissQuestion();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'AskUserQuestion', target: QUESTION, status: 'done' })).rejects.toThrow('only as dismissed, without the question');
        await product.expectReply('I will pick one myself.');
      },
    },
    'fails when the command printed something else, or the text was printed by another command': {
      run: async ({ product, model }) => {
        model.script(bash(PRINT_READY), bash('true'), say('Both commands ran.'));
        await product.send('Print one word, then run a command that prints nothing.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'steady' })).rejects.toThrow('did not find Bash');
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'read' })).rejects.toThrow('did not find Bash');
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: `Approved: Running: ${PRINT_READY}` })).rejects.toThrow('did not find Bash');
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'Output' })).rejects.toThrow('did not find Bash');
        await expect(product.expectTool({ name: 'Bash', target: 'true', status: 'done', output: 'ready' })).rejects.toThrow('did not find Bash');
        await product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'ready' });
        await product.expectTool({ name: 'Bash', target: 'true', status: 'done' });
      },
    },
    'does not take a part of a command, or a line it printed, for another command after its output was looked at': {
      run: async ({ product, model }) => {
        const printsACommand = "printf 'echo h%s\\n' i";
        model.script(bash(printsACommand), say('It printed a line that reads like a command.'));
        await product.send('Print a line that reads like a command.');
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: printsACommand, status: 'done', output: 'echo hi' });
        await expect(product.expectTool({ name: 'Bash', target: 'echo hi', status: 'done' })).rejects.toThrow('did not find Bash');
        await expect(product.expectTool({ name: 'Bash', target: 'printf', status: 'done' })).rejects.toThrow('did not find Bash');
        await product.expectTool({ name: 'Bash', target: printsACommand, status: 'done' });
      },
    },
    'does not take text of the reply for the output of a command': {
      run: async ({ product, model }) => {
        model.script(bash('true'), say('ready'));
        await product.send('Run a command that prints nothing, then say one word.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: 'true', status: 'done', output: 'ready' })).rejects.toThrow('did not find Bash');
        await product.expectReply('ready');
      },
    },
    'fails when the tool has finished but the scenario expects it running': {
      run: async ({ product, model }) => {
        model.script(bash(PRINT_READY), say('It printed one word.'));
        await product.send('Print one word with a shell command.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'running', output: 'ready' })).rejects.toThrow('did not find Bash');
        await product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'ready' });
      },
    },
    'does not take a command that has finished for a running one while the turn goes on': {
      run: async ({ product, model }) => {
        const second = "printf 'ste%s\\n' ady";
        model.script(bash(PRINT_READY), bash(second), say('Both commands ran.'));
        await product.send('Print one word, then print another.');
        await product.approve();
        await product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'ready' });
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'running', output: 'ready' })).rejects.toThrow('while an approval is pending');
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: second, status: 'done', output: 'steady' });
      },
    },
    'refuses to look for a running command while its approval is still pending': {
      run: async ({ product, model }) => {
        model.script(bash(PRINT_READY), say('It printed one word.'));
        await product.send('Print one word with a shell command.');
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'running', output: 'ready' })).rejects.toThrow('while an approval is pending');
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'ready' });
      },
    },
    'refuses an output it could not tell from the command, and one that is not a line of text': {
      run: async ({ product, model }) => {
        model.script(bash(PRINT_READY), say('It printed one word.'));
        await product.send('Print one word with a shell command.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'printf' })).rejects.toThrow('part of the command');
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: '' })).rejects.toThrow('one line of printable ASCII');
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'rea\ndy' })).rejects.toThrow('one line of printable ASCII');
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'running' } as never)).rejects.toThrow('only together with output');
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'running', output: 'ready' } as never)).rejects.toThrow('only for Bash');
        await expect(product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'rejected', output: 'ready' } as never)).rejects.toThrow('it never ran');
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done', output: 'ready' } as never)).rejects.toThrow('only for Bash');
        await product.expectTool({ name: 'Bash', target: PRINT_READY, status: 'done', output: 'ready' });
      },
    },
    'fails when the shell command is a different one, or failed but the scenario expects it done': {
      run: async ({ product, model }) => {
        model.script(bash('exit 3'), say('The command failed.'));
        await product.send('Run a command that fails.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: 'exit 4', status: 'failed' })).rejects.toThrow('did not find Bash');
        await expect(product.expectTool({ name: 'Bash', target: 'exit 3', status: 'done' })).rejects.toThrow('did not find Bash');
        await product.expectTool({ name: 'Bash', target: 'exit 3', status: 'failed' });
      },
    },
    'fails for a file that was not among several reads made in one step': {
      workspace: { 'a.txt': 'hello\n', 'b.txt': 'world\n' },
      run: async ({ product, model }) => {
        model.script(batch(read('a.txt'), read('b.txt')), say('I read both files.'));
        await product.send('Read a.txt and b.txt.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'c.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await expect(product.expectTool({ name: 'Read', target: 'a.txt', status: 'failed' })).rejects.toThrow('did not find Read');
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await product.expectReply('I read both files.');
      },
    },
    'fails when one of several reads made in one step failed but the scenario expects it done': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(batch(read('a.txt'), read('missing.txt')), say('One file was missing.'));
        await product.send('Read a.txt and missing.txt.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'missing.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await product.expectTool({ name: 'Read', target: 'missing.txt', status: 'failed' });
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await product.expectReply('One file was missing.');
      },
    },
    'fails when the tool failed but the scenario expects it done': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model }) => {
        model.script(edit({ path: 'b.txt', old_string: 'missing', new_string: 'new' }), say('The edit failed.'));
        await product.send('Change missing to new in b.txt.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' })).rejects.toThrow('did not find Edit');
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'rejected' })).rejects.toThrow('did not find Edit');
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'failed' });
      },
    },
    'fails when the target or the tool name is wrong': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model, workspace }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('Edited b.txt.'));
        await product.send('Change old to new in b.txt.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Edit', target: 'c.txt', status: 'done' })).rejects.toThrow('did not find Edit');
        await expect(product.expectTool({ name: 'Write', target: 'b.txt', status: 'done' })).rejects.toThrow('did not find Write');
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
        await workspace.expectFile('b.txt', 'new\n');
      },
    },
    'does not take reply text that looks like a tool card for a tool': {
      run: async ({ product, model }) => {
        model.script(say('Here is what a read would look like:\n\n● Used Read (a.txt) · 1 line\n\nBut I did not read anything.'));
        await product.send('Describe a read without doing one.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await product.expectReply('But I did not read anything.');
      },
    },
    'does not take a file of the same name in another directory': {
      workspace: { 'src/a.txt': 'one\n', 'docs/a.txt': 'two\n' },
      run: async ({ product, model }) => {
        model.script(read('src/a.txt'), say('I read the one under src.'));
        await product.send('Read src/a.txt.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'docs/a.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await expect(product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await product.expectTool({ name: 'Read', target: 'src/a.txt', status: 'done' });
        await product.expectReply('I read the one under src.');
      },
    },
    'does not take a line of the output of a command for the command itself': {
      run: async ({ product, model, workspace }) => {
        model.script(bash('echo ls -la | tee out.txt'), say('I only printed the command.'));
        await product.send('Print a command without running it.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: 'ls -la', status: 'done' })).rejects.toThrow('did not find Bash');
        await product.expectTool({ name: 'Bash', target: 'echo ls -la | tee out.txt', status: 'done' });
        await product.expectReply('I only printed the command.');
        await workspace.expectFile('out.txt', 'ls -la\n');
      },
    },
    'does not take a reply that names a tool and its target for the tool': {
      workspace: { 'package.json': '{}\n' },
      run: async ({ product, model }) => {
        model.script(say('Next step:\n\n**Run** `echo hi | tee out.txt`\n\nAfter that:\n\n- **Edit** package.json\n\nI did neither.'));
        await product.send('Describe two steps without doing them.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: 'echo hi | tee out.txt', status: 'done' })).rejects.toThrow('did not find Bash');
        await expect(product.expectTool({ name: 'Edit', target: 'package.json', status: 'done' })).rejects.toThrow('did not find Edit');
        await product.expectReply('I did neither.');
      },
    },
    'does not let a reply that repeats a failed command pass for a completed one': {
      run: async ({ product, model }) => {
        model.script(bash('exit 3'), say('**Run**\n\n`exit 3`'));
        await product.send('Run a command that fails, then repeat it in bold.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: 'exit 3', status: 'done' })).rejects.toThrow('did not find Bash');
        await product.expectTool({ name: 'Bash', target: 'exit 3', status: 'failed' });
      },
    },
    'does not take a tool from an earlier turn': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I read a.txt.'), say('Nothing to read this time.'));
        await product.send('Read a.txt.');
        await product.waitIdle();
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await product.send('Just answer.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await product.expectReply('Nothing to read this time.');
      },
    },
    'fails when the tool was rejected but the scenario expects it done or failed': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('I left b.txt alone.'));
        await product.send('Change old to new in b.txt.');
        await product.reject();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' })).rejects.toThrow('did not find Edit');
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'failed' })).rejects.toThrow('did not find Edit');
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'rejected' });
      },
    },
  },
});
