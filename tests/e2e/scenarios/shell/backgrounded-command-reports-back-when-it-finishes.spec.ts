import { bash, held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'moves a running command to the background, lets the turn go on, and reports back when the command finishes',
  { except: { acp: 'ACP has no background tasks an editor can move, list or stop: the agent reports only tool calls.' } },
  async ({ product, model, workspace }) => {
    const command = "printf 'rea%s\\n' dy; while [ ! -f gate.txt ]; do sleep 0.1; done; printf 'don%s\\n' e";
    const description = 'Run the slow build';
    model.script(bash({ command, description }), say('The build runs in the background.'), held('notified', say('The build finished.')));

    await product.send('Run the slow build.');
    await product.approve();
    await product.expectTool({ name: 'Bash', target: command, status: 'running', output: 'ready' });
    await product.background();
    await product.waitIdle();
    await product.expectReply('The build runs in the background.');
    await product.expectTask({ description, status: 'running' });

    await workspace.write('gate.txt', '');
    await model.hold('notified').reached();
    model.hold('notified').release();
    await product.waitIdle();
    await product.expectReply('The build finished.');
    await product.expectTask({ description, status: 'done', output: 'done' });

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[1]?.texts('tool').join('\n')).toContain('detached_by_user: true');
    expect(requests[2]?.userTextsSinceReply.join('\n')).toContain(`${description} completed.`);

    await product.restart();
    await product.expectReply('The build finished.');
    expect(model.requests('main')).toHaveLength(3);
  },
);
