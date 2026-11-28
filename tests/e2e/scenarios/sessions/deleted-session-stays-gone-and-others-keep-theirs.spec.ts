import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('deletes one session without touching the others, and the deleted one stays gone after a restart', {}, async ({ product, model }) => {
  model.script(say('Alpha reply.'), say('Beta reply.'), say('Gamma reply.'), say('Alpha again.'));

  await product.send('Alpha question');
  await product.expectReply('Alpha reply.');
  await product.waitIdle();
  await product.newSession();
  await product.send('Beta question');
  await product.expectReply('Beta reply.');
  await product.waitIdle();
  await product.newSession();
  await product.send('Gamma question');
  await product.expectReply('Gamma reply.');
  await product.waitIdle();

  await product.openSession('Alpha question');
  await product.deleteSession('Beta question');
  await product.expectSessions(['Alpha question', 'Gamma question']);
  await product.send('Alpha follow-up');
  await product.expectReply('Alpha again.');
  const followUp = model.requests('main')[3];
  expect(followUp?.texts('assistant')).toEqual(['Alpha reply.']);

  await product.waitIdle();
  await product.restart();
  await product.expectReply('Alpha again.');
  await product.expectSessions(['Alpha question', 'Gamma question']);
  await product.openSession('Gamma question');
  await product.expectTranscript('Gamma reply.');
});
