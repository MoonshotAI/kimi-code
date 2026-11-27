import { agent, askUserQuestion, bash, edit, glob, grep, read, say, todoList, write, type PromptCacheEntry } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const DATABASE = { question: 'Which database should we use?', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false };
const DEPLOY = { question: 'Should we deploy today?', header: 'Deploy', options: [{ label: 'Yes' }, { label: 'No' }], multi_select: false };

function lastTwoMainRequestsShareTheirPrefix(entries: readonly PromptCacheEntry[]): void {
  const main = entries.filter((entry) => entry.role === 'main' && !entry.rejected);
  const [before, after] = main.slice(-2);
  expect(after?.baseline).toBe(before?.request);
  expect(after?.break).toBeUndefined();
  expect(after?.reusedTokens).toBeGreaterThanOrEqual(before?.totalTokens ?? Number.POSITIVE_INFINITY);
}

scenario(
  'keeps the prompt cache prefix when the session restarts after tools of many kinds returned their results',
  { workspace: { 'notes.txt': 'alpha\n' } },
  async ({ product, model, workspace }) => {
    model.script(
      bash('exit 3'),
      write({ path: 'out.txt', content: 'written\n' }),
      edit({ path: 'notes.txt', old_string: 'alpha', new_string: 'beta' }),
      bash('touch refused.txt'),
      read('missing.txt'),
      grep('beta'),
      glob('*.txt'),
      todoList([{ title: 'step one', status: 'in_progress' }, { title: 'step two', status: 'pending' }]),
      askUserQuestion({ questions: [DATABASE] }),
      askUserQuestion({ questions: [DEPLOY] }),
      agent({ prompt: 'Say hello.', description: 'say hello' }),
      say('Done with the batch.'),
    );
    model.lane('subagent').script(say('Hello from the helper.'));
    await product.send('Run the batch.');
    await product.approve();
    await product.approve();
    await product.approve();
    await product.reject();
    await product.answer('SQLite');
    await product.dismissQuestion();
    await product.waitIdle();
    await product.expectReply('Done with the batch.');
    await workspace.expectFile('out.txt', 'written\n');
    await workspace.expectFile('notes.txt', 'beta\n');
    await workspace.expectMissing('refused.txt');

    await product.restart();
    model.script(say('Still here after the restart.'));
    await product.send('Continue after the restart.');
    await product.waitIdle();
    await product.expectReply('Still here after the restart.');

    const tools = model.requests('main').at(-1)?.texts('tool').join('\n') ?? '';
    expect(tools).toContain('Wrote 8 bytes to out.txt');
    expect(tools).toContain('Replaced 1 occurrence in notes.txt');
    expect(tools).toContain('Hello from the helper.');
    lastTwoMainRequestsShareTheirPrefix(model.promptCache());
  },
);

scenario(
  'keeps the prompt cache prefix when the user reloads the session after the model wrote and edited files',
  {
    except: { acp: 'ACP has no request to reload a session, and kimi acp does not offer /reload to the editor.' },
    workspace: { 'notes.txt': 'alpha\n' },
  },
  async ({ product, model, workspace }) => {
    model.script(write({ path: 'out.txt', content: 'written\n' }), edit({ path: 'notes.txt', old_string: 'alpha', new_string: 'beta' }), say('Wrote and edited.'));
    await product.send('Write out.txt and edit notes.txt.');
    await product.approve();
    await product.approve();
    await product.waitIdle();
    await product.expectReply('Wrote and edited.');
    await workspace.expectFile('out.txt', 'written\n');
    await workspace.expectFile('notes.txt', 'beta\n');

    await product.reload();
    model.script(say('Still here after the reload.'));
    await product.send('Continue after the reload.');
    await product.waitIdle();
    await product.expectReply('Still here after the reload.');

    expect(model.requests('main').at(-1)?.texts('tool').join('\n')).toContain('Wrote 8 bytes to out.txt');
    lastTwoMainRequestsShareTheirPrefix(model.promptCache());
  },
);

scenario(
  'keeps the prompt cache prefix when the session restarts after the user stopped a turn whose command waited for approval',
  { except: { tui: 'The terminal UI cannot stop a turn while an approval is pending: Esc, Ctrl+C and Ctrl+D answer the approval panel.' } },
  async ({ product, model, workspace }) => {
    model.script(bash('touch never.txt'));
    await product.send('Create never.txt.');
    await product.expectApproval({ name: 'Bash', target: 'touch never.txt' });
    await product.stop();
    await product.waitIdle();
    await workspace.expectMissing('never.txt');

    await product.restart();
    model.script(say('Still here after the restart.'));
    await product.send('Continue after the restart.');
    await product.waitIdle();
    await product.expectReply('Still here after the restart.');

    expect(model.requests('main').at(-1)?.texts('user')).toContain('Create never.txt.');
    lastTwoMainRequestsShareTheirPrefix(model.promptCache());
  },
);
