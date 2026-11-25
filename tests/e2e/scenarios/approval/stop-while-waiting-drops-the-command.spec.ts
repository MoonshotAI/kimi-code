import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'drops a command that waits for approval when the user stops the turn',
  { except: { tui: 'The terminal UI has no way to stop a turn without answering its approval: Esc, Ctrl+C and Ctrl+D on the approval panel reject it.' } },
  async ({ product, model, workspace }) => {
    const command = "printf 'x\\n' > marker.txt";
    const followUp = 'Never mind, just say hi.';
    model.script(bash(command));

    await product.send('Record that the deploy was approved.');
    await product.expectApproval({ name: 'Bash', target: command });
    await product.stop();
    await product.waitIdle();
    expect(model.requests('main')).toHaveLength(1);
    await product.expectTool({ name: 'Bash', target: command, status: 'failed' });
    await workspace.expectMissing('marker.txt');

    model.script(say('Hi there.'));
    await product.send(followUp);
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.userTextsSinceReply).toEqual([followUp]);
    expect(requests[1]?.texts('user').filter((text) => text === 'Record that the deploy was approved.')).toHaveLength(1);
    expect(requests[1]?.remindersSinceReply.join('\n')).toContain('The previous turn was interrupted by the user before completion');
    expect(requests[1]?.texts('tool').join('\n')).toMatch(/Aborted before command started|was not run because the approval request was cancelled/);
    await product.expectReply('Hi there.');
    await workspace.expectMissing('marker.txt');
  },
);
