import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('keeps the prompt cache prefix when the user turns plan mode on and off again between turns', {}, async ({ product, model }) => {
  model.script(say('Hello there.'), say('First I would read the code.'), say('Back to normal.'));
  await product.send('Hello.');
  await product.waitIdle();
  await product.expectReply('Hello there.');

  await product.setPlanMode('on');
  await product.send('How would you add a cache?');
  await product.waitIdle();
  await product.expectReply('First I would read the code.');

  await product.setPlanMode('off');
  await product.send('Thanks, that is all.');
  await product.waitIdle();
  await product.expectReply('Back to normal.');

  const requests = model.requests('main');
  expect(requests).toHaveLength(3);
  const reminders = requests.map((request) => request.remindersSinceReply.join('\n'));
  expect(reminders[0]).not.toContain('Plan mode');
  expect(reminders[1]).toContain('Plan mode is active');
  expect(reminders[2]).toContain('Plan mode is no longer active');
  expect(reminders[2]).not.toContain('Plan mode is active');
  expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
  expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));

  const main = model.promptCache().filter((entry) => entry.role === 'main');
  expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
  expect(main.every((entry) => entry.break === undefined)).toBe(true);
});
