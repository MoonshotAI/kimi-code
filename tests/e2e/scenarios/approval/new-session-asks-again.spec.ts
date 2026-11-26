import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('asks again in a new session for a command the user approved for the previous session', {}, async ({ product, model, workspace }) => {
  const command = "printf 'run\\n' >> runs.txt";
  model.script(bash(command), say('Logged a run.'), bash(command), say('Logged another run.'), bash(command), say('Logged a run in the new session.'));

  await product.send('Log a run.');
  await product.expectApproval({ name: 'Bash', target: command });
  await product.approve({ for: 'session' });
  await product.waitIdle();

  await product.send('Log another run.');
  await product.waitIdle();
  await product.expectTool({ name: 'Bash', target: command, status: 'done' });
  await product.expectReply('Logged another run.');

  await product.newSession();
  await product.send('Log a run in this new session.');
  await product.expectApproval({ name: 'Bash', target: command });
  await product.approve();
  await product.waitIdle();
  await product.expectTool({ name: 'Bash', target: command, status: 'done' });
  await product.expectReply('Logged a run in the new session.');

  expect(model.requests('main')).toHaveLength(6);
  expect(model.requests('main')[4]?.texts('user').some((text) => text.includes('Log a run.'))).toBe(false);
  await workspace.expectFile('runs.txt', 'run\nrun\nrun\n');
});
