import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('shows what a failing command printed, and gives it and the exit code to the model', {}, async ({ product, model }) => {
  const command = "printf 'bo%s\\n' om >&2; exit 3";
  model.script(bash(command), say('The command failed with exit code 3.'));

  await product.send('Run the check script.');
  await product.approve();
  await product.waitIdle();

  const requests = model.requests('main');
  expect(requests.map((request) => request.state)).toEqual(['finished', 'finished']);
  expect(requests[1]?.texts('tool').join('\n')).toMatch(/(^|\n)boom\nCommand failed with exit code: 3\.(\n|$)/);
  await product.expectTool({ name: 'Bash', target: command, status: 'failed', output: 'boom' });
  await product.expectReply('The command failed with exit code 3.');
});
