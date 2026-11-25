import { bash, batch, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('asks for two commands from one reply one after the other and runs each once', {}, async ({ product, model, workspace }) => {
  const first = "printf 'one\\n' >> one.txt";
  const second = "printf 'two\\n' >> two.txt";
  model.script(batch(bash(first), bash(second)), say('Both files are written.'));

  await product.send('Write one.txt and two.txt.');
  await product.expectApproval({ name: 'Bash', target: first });
  await product.approve();
  await product.expectApproval({ name: 'Bash', target: second });
  await product.approve();
  await product.waitIdle();

  const requests = model.requests('main');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.texts('tool')).toHaveLength(2);
  await product.expectTool({ name: 'Bash', target: first, status: 'done' });
  await product.expectTool({ name: 'Bash', target: second, status: 'done' });
  await product.expectReply('Both files are written.');
  await workspace.expectFile('one.txt', 'one\n');
  await workspace.expectFile('two.txt', 'two\n');
});
