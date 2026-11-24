import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('runs a shell command once after approval and gives its output to the model', {}, async ({ product, model, workspace }) => {
  const prompt = 'Append hi to out.txt with a shell command.';
  const command = 'echo hi | tee -a out.txt';
  model.script(bash(command), say('Appended hi to out.txt.'));

  await product.send(prompt);
  await product.approve();
  await product.waitIdle();

  const requests = model.requests('main');
  expect(requests.map((request) => request.firstUserText)).toEqual([prompt, prompt]);
  expect(requests[1]?.texts('tool').join('\n').match(/^hi$/gm)).toEqual(['hi']);
  await product.expectTool({ name: 'Bash', target: command, status: 'done' });
  await product.expectReply('Appended hi to out.txt.');
  await workspace.expectFile('out.txt', 'hi\n');
});
