import { agent, held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'does not call the model on its own when the user reopens a session whose background subagent was still running, and tells it once that the task stopped',
  {},
  async ({ product, model }) => {
    const started = 'Started the count in the background.';
    const after = 'The count stopped when the product closed.';
    model.script(agent({ prompt: 'Count the files.', description: 'count files', run_in_background: true }), say(started));
    model.lane('subagent').script(held('counting', say('42 files')));

    await product.send('Count the files in the background.');
    const counting = await model.hold('counting').reached();
    await product.waitIdle();
    await product.expectReply(started);

    await product.restart();
    expect(counting.state).toBe('aborted');
    expect(model.requests('main')).toHaveLength(2);

    model.script(say(after));
    await product.send('What happened to the count?');
    await product.waitIdle();
    await product.expectReply(after);

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[2]?.texts('user').join('\n').split('source_kind="background_task"')).toHaveLength(2);
    expect(requests[2]?.userTextsSinceReply.at(-1)).toBe('What happened to the count?');
    expect(model.requests('subagent')).toHaveLength(1);
  },
);
