import { askUserQuestion, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'gives the model the answer the user typed instead of picking an option',
  { except: { acp: "ACP's permission request carries only option ids, so an editor cannot send a free-text answer." } },
  async ({ product, model }) => {
    const question = 'Which database should we use?';
    const typed = 'Whatever the team already runs';
    model.script(
      askUserQuestion({ questions: [{ question, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] }),
      say('I will ask the team which one they run.'),
    );

    await product.send('Help me choose a database.');
    await product.answerOther(typed);
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.texts('tool').map((text) => JSON.parse(text) as unknown)).toEqual([{ answers: { [question]: typed } }]);
    await product.expectTool({ name: 'AskUserQuestion', target: question, status: 'done' });
    await product.expectReply('I will ask the team which one they run.');
  },
);
