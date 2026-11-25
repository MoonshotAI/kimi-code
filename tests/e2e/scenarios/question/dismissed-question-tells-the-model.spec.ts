import { askUserQuestion, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('tells the model the user dismissed its question', {}, async ({ product, model }) => {
  model.script(
    askUserQuestion({ questions: [{ question: 'Which database should we use?', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] }),
    say('No answer, so I will keep the current setup.'),
  );

  await product.send('Help me choose a database.');
  await product.dismissQuestion();
  await product.waitIdle();

  const requests = model.requests('main');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.texts('tool').map((text) => JSON.parse(text) as unknown)).toEqual([{ answers: {}, note: 'User dismissed the question without answering.' }]);
  await product.expectReply('No answer, so I will keep the current setup.');
});
