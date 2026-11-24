import { edit, held, say, unitsOf } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'stops a turn before its pending edit runs, and answers the next message',
  { workspace: { 'b.txt': 'old\n' } },
  async ({ product, model, workspace }) => {
    const prompt = 'Update b.txt.';
    const followUp = 'Are you still there?';
    const pending = edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }, { text: 'Let me update b.txt.' });
    model.script(held('before-the-end', pending, unitsOf(pending)), say('Yes, and b.txt is untouched.'));

    await product.send(prompt);
    await model.hold('before-the-end').reached();
    await product.expectReply('Let me update b.txt.');
    await product.stop();
    await product.waitIdle();
    model.hold('before-the-end').release();
    expect(model.requests('main').map((request) => request.state)).toEqual(['aborted']);

    await product.send(followUp);
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests.map((request) => request.state)).toEqual(['aborted', 'finished']);
    expect(requests[1]?.firstUserText).toBe(prompt);
    expect(requests[1]?.userTextsSinceReply.at(-1)).toBe(followUp);
    await product.expectReply('Yes, and b.txt is untouched.');
    await workspace.expectFile('b.txt', 'old\n');
  },
);
