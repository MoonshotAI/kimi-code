import { askUserQuestion, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('gives the model the option the user picked', {}, async ({ product, model }) => {
  const question = 'Which database should we use?';
  model.script(
    askUserQuestion({ questions: [{ question, header: 'Database', options: [{ label: 'Postgres', description: 'A server database' }, { label: 'SQLite', description: 'A file on disk' }], multi_select: false }] }),
    say('Setting up the file database.'),
  );

  await product.send('Help me choose a database.');
  await product.answer('SQLite');
  await product.waitIdle();

  const requests = model.requests('main');
  expect(requests).toHaveLength(2);
  const results = requests[1]?.texts('tool') ?? [];
  expect(results.map((text) => JSON.parse(text) as unknown)).toEqual([{ answers: { [question]: 'SQLite' } }]);
  expect(results.join('\n')).not.toContain('Postgres');
  await product.expectTool({ name: 'AskUserQuestion', target: question, status: 'done' });
  await product.expectReply('Setting up the file database.');
});
