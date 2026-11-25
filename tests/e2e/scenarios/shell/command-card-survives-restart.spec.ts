import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('keeps the card of a finished command, with its status and output, after the user restarts the product', {}, async ({ product, model }) => {
  const passing = 'echo $((40 + 2))';
  const failing = 'echo $((6 * 7)) && exit 3';
  model.script(bash(passing), bash(failing), say('One command passed and one failed.'));

  await product.send('Run both checks.');
  await product.approve();
  await product.approve();
  await product.waitIdle();
  await product.expectTool({ name: 'Bash', target: passing, status: 'done', output: '42' });
  await product.expectTool({ name: 'Bash', target: failing, status: 'failed', output: '42' });

  await product.restart();
  await product.expectTool({ name: 'Bash', target: passing, status: 'done', output: '42' });
  await product.expectTool({ name: 'Bash', target: failing, status: 'failed', output: '42' });
  await product.expectReply('One command passed and one failed.');
  expect(model.requests('main')).toHaveLength(3);
});
