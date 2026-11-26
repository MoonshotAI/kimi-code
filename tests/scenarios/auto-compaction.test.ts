import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { read, say } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures({
  config: {
    models: { testkit: { provider: 'testkit', model: 'testkit-model', maxContextSize: 40_000 } },
    loopControl: { compaction_trigger_ratio: 0.7 },
  },
}));

const logLines = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line ${index} ${'x'.repeat(30)}`).join('\n');

test('applies an automatic compaction that starts below the block ratio before the next step', async ({ kap, model }) => {
  await writeFile(join(kap.home.workspace, 'a.log'), logLines(850));
  await writeFile(join(kap.home.workspace, 'b.log'), logLines(500));
  model.lane('compaction').script(say('Summary: both logs were read.'));
  model.script(read('a.log'), say('Read the first log.'), read('b.log'), say('Read the second log.'));
  const session = await kap.createSession();

  await kap.prompt(session.id, 'Read a.log.');
  await kap.waitIdle(session.id);
  await kap.prompt(session.id, 'Read b.log.');
  await kap.waitIdle(session.id);

  const turns = await kap.turns(session.id);
  expect(turns.map((turn) => turn['outcome'])).toEqual(['completed', 'completed']);
  expect(turns[1]?.items).toContainEqual(expect.objectContaining({ type: 'system', kind: 'compaction' }));
  const compaction = model.requests('compaction');
  expect(compaction).toHaveLength(1);
  const afterCompaction = model.requests('main').filter((request) => request.index > compaction[0]!.index);
  expect(afterCompaction).toHaveLength(1);
  const texts = afterCompaction[0]!.view.messages.map((message) => message.text);
  expect(texts).toEqual(expect.arrayContaining([expect.stringContaining('Summary: both logs were read.')]));
  expect(texts.some((text) => text.includes('line 849'))).toBe(false);
});
