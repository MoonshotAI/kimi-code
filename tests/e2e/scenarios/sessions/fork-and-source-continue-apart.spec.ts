import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

function mentions(texts: readonly string[], text: string): boolean {
  return texts.some((entry) => entry.includes(text));
}

scenario('keeps a forked session and its source apart: each continues from the shared history without the other side’s messages', {}, async ({ product, model }) => {
  model.script(say('The plan is ready.'), say('The hotel is booked.'), say('The train is booked.'));

  await product.send('Plan the trip.');
  await product.expectReply('The plan is ready.');
  await product.fork();
  await product.expectSessions(['Plan the trip.', 'Fork: Plan the trip.']);
  await product.expectTranscript('The plan is ready.');

  await product.send('Book the hotel.');
  await product.expectReply('The hotel is booked.');
  await product.openSession('Plan the trip.');
  await product.send('Book the train.');
  await product.expectReply('The train is booked.');

  const [, inFork, inSource] = model.requests('main');
  expect(mentions(inFork?.texts('user') ?? [], 'Plan the trip.')).toBe(true);
  expect(inFork?.texts('assistant')).toContain('The plan is ready.');
  expect(mentions(inFork?.texts('user') ?? [], 'Book the train.')).toBe(false);
  expect(mentions(inSource?.texts('user') ?? [], 'Plan the trip.')).toBe(true);
  expect(inSource?.texts('assistant')).toContain('The plan is ready.');
  expect(mentions(inSource?.texts('user') ?? [], 'Book the hotel.')).toBe(false);
  expect(inSource?.texts('assistant')).not.toContain('The hotel is booked.');

  await product.waitIdle();
  await product.restart();
  await product.expectReply('The train is booked.');
  await product.expectSessions(['Plan the trip.', 'Fork: Plan the trip.']);
});
