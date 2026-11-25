import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('builds the next turn from the summary after the user compacts the context by hand, also after a restart', {}, async ({ product, model }) => {
  const first = 'Summarize the parser module.';
  const firstReply = 'The parser module tokenizes the input and builds a syntax tree.';
  const summary = 'The user asked about the parser module, which tokenizes input and builds a syntax tree.';
  const next = 'Now describe the emitter.';
  const nextReply = 'The emitter writes the output files.';
  model.script(say(firstReply), say(nextReply));
  model.lane('compaction').script(say(summary));

  await product.send(first);
  await product.waitIdle();
  await product.compact();
  expect(model.requests('compaction')).toHaveLength(1);
  await product.restart();

  await product.send(next);
  await product.waitIdle();
  await product.expectReply(nextReply);
  const request = model.requests('main').at(-1);
  expect(request?.texts('assistant').some((text) => text.includes(firstReply))).toBe(false);
  expect(request?.texts('user').some((text) => text.includes(summary))).toBe(true);
  expect(request?.userTextsSinceReply.at(-1)).toBe(next);
});
