import { httpError, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const CONTINUE_REMINDER = 'No new user message was sent. Continue the interrupted work from where it stopped; do not repeat steps that already completed.';

scenario(
  'continues a failed turn from where it stopped without sending a new message',
  {
    onlyOn: ['desktop', 'web'],
    reason: 'Only Desktop and Web offer Continue on a failed turn; in the terminal UI and over ACP a user sends another message instead.',
  },
  async ({ product, model }) => {
    const prompt = 'Summarise the project status.';
    const refusal = 'The example service refused this request.';
    model.script(httpError(400, { message: refusal }), say('The project is on track.'));

    await product.send(prompt);
    await product.waitIdle();
    await product.expectError(refusal);
    await product.continue();
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests.map((request) => request.state)).toEqual(['failed', 'finished']);
    expect(requests[1]?.userTextsSinceReply).toEqual([prompt]);
    expect(requests[1]?.remindersSinceReply.at(-1)).toBe(CONTINUE_REMINDER);
    expect(requests[1]?.texts('user').some((text) => text.trim() === 'Continue')).toBe(false);
    await product.expectReply('The project is on track.');
  },
);
