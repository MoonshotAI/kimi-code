import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'steers a message the user queued into the running turn, instead of running it after the turn',
  { except: { acp: 'ACP has no way to send a message while a turn runs: the editor waits for the session/prompt answer before it sends the next one.' } },
  async ({ product, model, workspace }) => {
    const command = "printf 'rea%s\\n' dy; while [ ! -f gate.txt ]; do sleep 0.1; done; printf 'buil%s\\n' t";
    const queued = 'Use the release profile.';
    model.script(bash(command), say('Built it with the release profile.'));

    await product.send('Run the slow build.');
    await product.approve();
    await product.expectTool({ name: 'Bash', target: command, status: 'running', output: 'ready' });
    await product.queue(queued);
    await product.steerQueued();
    expect(model.requests('main')).toHaveLength(1);
    await workspace.write('gate.txt', '');
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests.map((request) => request.state)).toEqual(['finished', 'finished']);
    expect(requests[1]?.texts('tool').join('\n')).toMatch(/(^|\n)built(\n|$)/);
    expect(requests[1]?.userTextsSinceReply).toEqual([queued]);
    await product.expectReply('Built it with the release profile.');
    await product.expectTranscript(queued);
  },
);
