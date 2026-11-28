import { askUserQuestion, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('still shows a question the user answered after the user restarts the product', {}, async ({ product, model }) => {
  const question = 'Which database should we use?';
  model.script(
    askUserQuestion({ questions: [{ question, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] }),
    say('Setting up the file database.'),
  );

  await product.send('Help me choose a database.');
  await product.answer('SQLite');
  await product.waitIdle();
  await product.expectTool({ name: 'AskUserQuestion', target: question, status: 'done' });

  await product.restart();
  await product.expectTool({ name: 'AskUserQuestion', target: question, status: 'done' });
  await product.expectReply('Setting up the file database.');
  expect(model.requests('main')).toHaveLength(2);
});
