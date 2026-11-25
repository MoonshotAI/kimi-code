import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('keeps what a stopped command printed', {}, async ({ product, model }) => {
  const command = "printf 'rea%s\\n' dy; sleep 30";
  const answer = 'It printed ready before you stopped it.';
  model.script(bash(command), say(answer));

  await product.send('Run the slow command.');
  await product.approve();
  await product.expectTool({ name: 'Bash', target: command, status: 'running', output: 'ready' });
  await product.stop();
  await product.waitIdle();
  await product.expectTool({ name: 'Bash', target: command, status: 'failed', output: 'ready' });
  expect(model.requests('main').map((request) => request.state)).toEqual(['finished']);

  await product.send('What did it print?');
  await product.waitIdle();
  const requests = model.requests('main');
  expect(requests.map((request) => request.state)).toEqual(['finished', 'finished']);
  expect(requests[1]?.texts('tool').join('\n')).toMatch(/(^|\n)ready(\n|$)/);
  await product.expectReply(answer);
});
