import { bash, held, say } from '@moonshot-ai/testkit/model';

import { scenario } from '../../support/scenario';

scenario(
  'marks a session that finished in the background as unread, and one waiting for an approval with a badge, until the user opens it',
  {
    onlyOn: ['desktop', 'web'],
    reason: 'Only Desktop and Web list sessions side by side with marks; the terminal UI shows one session at a time and an ACP editor keeps its own list.',
  },
  async ({ product, model, workspace }) => {
    model.script(
      say('Beta reply.'),
      held('alpha working', say('Alpha finished in the background.')),
      bash({ command: 'echo cleaned > cache.txt', description: 'Clean the cache' }),
      say('Cache cleaned.'),
    );

    await product.send('Beta question');
    await product.expectReply('Beta reply.');
    await product.waitIdle();
    await product.newSession();
    await product.send('Alpha question');
    await model.hold('alpha working').reached();
    await product.openSession('Beta question');
    model.hold('alpha working').release();
    await product.expectSessionBadge('Alpha question', 'unread');
    await product.expectSessionBadge('Beta question', 'none');

    await product.openSession('Alpha question');
    await product.expectReply('Alpha finished in the background.');
    await product.expectSessionBadge('Alpha question', 'none');

    await product.send('Clean the cache.');
    await product.expectApproval({ name: 'Bash', target: 'echo cleaned > cache.txt' });
    await product.openSession('Beta question');
    await product.expectSessionBadge('Alpha question', 'approval');
    await workspace.expectMissing('cache.txt');

    await product.openSession('Alpha question');
    await product.approve();
    await product.expectReply('Cache cleaned.');
    await product.expectSessionBadge('Alpha question', 'none');
    await workspace.expectFile('cache.txt', 'cleaned\n');
  },
);
