import { agent, held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps the earlier reply when a background subagent finishes and the product starts a turn to report it',
  {
    except: {
      acp: 'An ACP editor gets no signal when a turn the agent starts on its own ends; background-task-reply-reaches-acp-editor covers ACP.',
    },
  },
  async ({ product, model }) => {
    const started = 'Started the count in the background.';
    const finished = 'The background count is done: 42 files.';
    model.script(agent({ prompt: 'Count the files.', description: 'count files', run_in_background: true }), say(started), say(finished));
    model.lane('subagent').script(held('counting', say('42 files')));

    await product.send('Count the files in the background.');
    await model.hold('counting').reached();
    await product.waitIdle();
    await product.expectReply(started);

    model.hold('counting').release();
    await expect.poll(() => model.requests('main').filter((request) => request.state === 'finished').length, { timeout: 30_000 }).toBe(3);
    await product.waitIdle();
    expect(model.requests('main')[2]?.texts('user').join('\n')).toContain('type="task.completed"');
    await product.expectTranscript(started);
    await product.expectTranscript(finished);
  },
);
