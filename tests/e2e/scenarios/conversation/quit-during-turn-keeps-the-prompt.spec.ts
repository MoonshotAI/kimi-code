import { held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('keeps the prompt when the user quits while the model is answering, and sends it once with the next prompt', {}, async ({ product, model }) => {
  const prompt = 'Summarise the release notes for me.';
  const followUp = 'Never mind, just give me the headline.';
  const headline = 'The headline is a faster start-up.';
  model.script(held('answering', say(['Here is the summary so far, ', 'and here is the rest of it.']), 1), say(headline));

  await product.send(prompt);
  const interrupted = await model.hold('answering').reached();
  await product.restartDuringTurn();
  expect(interrupted.state).toBe('aborted');
  await product.waitIdle();
  await product.expectTranscript(prompt);

  await product.send(followUp);
  await product.waitIdle();
  await product.expectReply(headline);
  const requests = model.requests('main');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.texts('user').filter((text) => text === prompt)).toHaveLength(1);
  expect(requests[1]?.userTextsSinceReply).toContain(followUp);
});
