import { bash, held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps a background command running when the user stops the turn, and tells the model when the user stops the command itself',
  { except: { acp: 'An editor cannot stop one background task over ACP; it can only cancel the whole turn.' } },
  async ({ product, model }) => {
    const command = "while true; do printf 'tick\\n'; sleep 1; done";
    const description = 'Watch the logs';
    model.script(
      bash({ command, description, run_in_background: true }),
      held('writing', say(['Watching the logs ', 'while I work.']), 1),
      held('stopped', say('The log watcher was stopped.')),
    );

    await product.send('Watch the logs in the background.');
    await product.approve();
    await model.hold('writing').reached();
    await product.stop();
    await product.waitIdle();
    model.hold('writing').release();
    await product.expectTask({ description, status: 'running' });

    await product.stopTask(description);
    await model.hold('stopped').reached();
    model.hold('stopped').release();
    await product.waitIdle();
    await product.expectReply('The log watcher was stopped.');
    await product.expectTask({ description, status: 'stopped' });

    const requests = model.requests('main');
    expect(requests.map((request) => request.state)).toEqual(['finished', 'aborted', 'finished']);
    expect(requests[2]?.userTextsSinceReply.join('\n')).toContain('type="task.killed"');
    expect(requests[2]?.userTextsSinceReply.join('\n')).toContain(`${description} was stopped`);
  },
);
