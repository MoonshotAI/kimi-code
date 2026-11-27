import { say } from '@moonshot-ai/testkit/model';

import { scenario } from '../../support/scenario';

scenario(
  'archives one session without touching the others, and it stays out of the list after a restart',
  { onlyOn: ['desktop', 'web'], reason: 'Only Desktop and Web can archive a session; the terminal UI and ACP can only delete one.' },
  async ({ product, model }) => {
    model.script(say('Alpha reply.'), say('Beta reply.'), say('Alpha again.'));

    await product.send('Alpha question');
    await product.expectReply('Alpha reply.');
    await product.newSession();
    await product.send('Beta question');
    await product.expectReply('Beta reply.');
    await product.waitIdle();

    await product.openSession('Alpha question');
    await product.archiveSession('Beta question');
    await product.expectSessions(['Alpha question']);
    await product.send('Alpha follow-up');
    await product.expectReply('Alpha again.');

    await product.waitIdle();
    await product.restart();
    await product.expectReply('Alpha again.');
    await product.expectSessions(['Alpha question']);
  },
);
