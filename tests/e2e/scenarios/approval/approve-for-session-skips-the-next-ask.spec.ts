import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('does not ask again for a command the user approved for the session', {}, async ({ product, model, workspace }) => {
  const repeated = "printf 'one\\n' >> log.txt";
  const other = "printf 'two\\n' > other.txt";
  model.script(bash(repeated), bash(repeated), bash(other), say('Logged twice and wrote other.txt.'));

  await product.send('Log one twice, then write other.txt.');
  await product.expectApproval({ name: 'Bash', target: repeated });
  await product.approve({ for: 'session' });
  await product.expectApproval({ name: 'Bash', target: other });
  await product.approve();
  await product.waitIdle();

  const requests = model.requests('main');
  expect(requests).toHaveLength(4);
  expect(requests[3]?.texts('tool')).toHaveLength(3);
  await product.expectTool({ name: 'Bash', target: repeated, status: 'done' });
  await product.expectTool({ name: 'Bash', target: other, status: 'done' });
  await product.expectReply('Logged twice and wrote other.txt.');
  await workspace.expectFile('log.txt', 'one\none\n');
  await workspace.expectFile('other.txt', 'two\n');
});
