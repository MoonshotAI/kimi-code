import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps a pinned conversation pinned when the web UI is opened on another port',
  {
    onlyOn: ['web'],
    reason: 'Only the web UI is opened at an address a user can change; a new port is a new browser origin with empty browser storage. Desktop gets a new server port on every launch, which restart() already covers.',
  },
  async ({ product, model }) => {
    const prompt = 'Remember this conversation for later.';
    model.script(say('Noted, it is pinned.'), say('You asked me to remember this conversation.'));

    await product.send(prompt);
    await product.waitIdle();
    await product.expectReply('Noted, it is pinned.');
    await product.pinSession();

    await product.reopenOnAnotherPort();
    await product.expectPinned();
    await product.expectTranscript(prompt);

    await product.send('What did I ask you before?');
    await product.waitIdle();
    await product.expectReply('You asked me to remember this conversation.');
    expect(model.requests('main')[1]?.texts('user')).toContain(prompt);
  },
);
