import { askUserQuestion, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'still shows a question the user dismissed after the user restarts the product',
  {
    except: {
      tui: 'The terminal UI shows a dismissed question only as dismissed, without the question it asked, so there is nothing to find before or after the restart.',
    },
  },
  async ({ product, model }) => {
    const question = 'Which database should we use?';
    model.script(
      askUserQuestion({ questions: [{ question, header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false }] }),
      say('No answer, so I will keep the current setup.'),
    );

    await product.send('Help me choose a database.');
    await product.dismissQuestion();
    await product.waitIdle();
    await product.expectTool({ name: 'AskUserQuestion', target: question, status: 'done' });

    await product.restart();
    await product.expectTool({ name: 'AskUserQuestion', target: question, status: 'done' });
    await product.expectReply('No answer, so I will keep the current setup.');
    expect(model.requests('main')).toHaveLength(2);
  },
);
