import { bash, held, say, waitFor } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps a message sent during a wait for a background command in the queue, and steering it ends the wait while the command keeps running',
  {
    config: {
      extra: {
        experimental: {
          cli: { wait_for: true },
          desktop: { wait_for: true },
        },
      },
    },
    except: { acp: 'ACP has no way to send a message while a turn runs: the editor waits for the session/prompt answer before it sends the next one.' },
  },
  async ({ product, model, workspace }) => {
    const command = "printf 'rea%s\\n' dy; while [ ! -f gate.txt ]; do sleep 0.1; done; printf 'don%s\\n' e";
    const description = 'Run the slow build';
    const steered = 'Check the logs while it runs.';
    model.script(
      bash({ command, description, run_in_background: true }),
      waitFor({ timeout: 90 }),
      held('answer', say('Checking the logs while the build keeps running.')),
      held('built', say('The build finished.')),
    );

    await product.send('Run the slow build and wait for it.');
    await product.approve();
    await product.expectTool({ name: 'WaitFor', status: 'running' });
    await product.queue(steered);
    await product.expectTool({ name: 'WaitFor', status: 'running' });
    expect(model.requests('main')).toHaveLength(2);

    await product.steerQueued();
    const answer = await model.hold('answer').reached();
    model.hold('answer').release();
    await product.waitIdle();
    await product.expectReply('Checking the logs while the build keeps running.');
    await product.expectTool({ name: 'WaitFor', status: 'done', outcome: 'interrupted' });
    await product.expectTask({ description, status: 'running' });

    await workspace.write('gate.txt', '');
    const built = await model.hold('built').reached();
    model.hold('built').release();
    await product.waitIdle();
    await product.expectReply('The build finished.');
    await product.expectTask({ description, status: 'done', output: 'done' });

    expect(answer.userTextsSinceReply).toEqual([steered]);
    expect(answer.texts('tool').join('\n')).toContain('wait_status: interrupted');
    expect(built.userTextsSinceReply.join('\n')).toContain(`${description} completed.`);
    expect(built.texts('user').filter((text) => text.includes(steered))).toHaveLength(1);
    expect(model.requests('main').map((request) => request.state)).toEqual(['finished', 'finished', 'finished', 'finished']);
  },
);
