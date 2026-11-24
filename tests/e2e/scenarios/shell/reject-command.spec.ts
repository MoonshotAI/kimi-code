import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('does not run a shell command the user rejects', {}, async ({ product, model, workspace }) => {
  const prompt = 'Append hi to out.txt with a shell command.';
  const command = 'echo hi | tee -a out.txt';
  model.script(bash(command), say('Okay, I did not run it.'));

  await product.send(prompt);
  await product.reject();
  await product.waitIdle();

  const requests = model.requests('main');
  expect(requests.map((request) => request.firstUserText)).toEqual([prompt, prompt]);
  expect(requests[1]?.texts('tool').join('\n')).toContain('was not run because the user rejected the approval request.');
  await product.expectTool({ name: 'Bash', target: command, status: 'rejected' });
  await product.expectReply('Okay, I did not run it.');
  await workspace.expectMissing('out.txt');
});
