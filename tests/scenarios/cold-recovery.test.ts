import { createTestHome, writeKimiConfig, type TestHome } from '@moonshot-ai/testkit/fixtures';
import { KapProcess, type KapSocket, type KapTurn } from '@moonshot-ai/testkit/kap';
import { fakeModelConfig, say, type FakeModel } from '@moonshot-ai/testkit/model';
import { modelFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { corpusProblems, installCorpus, releasedCorpora, RELEASED_ANSWER, RELEASED_PROMPT, type ReleasedCorpus } from './support/released-corpus';

const test = base.extend<ModelFixtures>(modelFixtures());
const corpora = await releasedCorpora();
const CORPUS_TIMEOUT_MS = 90_000;

function startServer(home: TestHome): Promise<KapProcess> {
  return KapProcess.start({ home, env: { KIMI_CODE_PERSISTENCE_MINIDB_READMODEL: undefined } });
}

async function subscribe(server: KapProcess, sessionId: string): Promise<KapSocket> {
  const socket = await server.connect();
  await socket.subscribe(sessionId);
  return socket;
}

async function continueAndRecover(corpus: ReleasedCorpus, home: TestHome, model: FakeModel): Promise<void> {
  const { writer, sessionId: id } = corpus.manifest;
  await installCorpus(corpus, home);
  await writeKimiConfig(home.dataDir, fakeModelConfig(model, { type: 'openai' }));
  const first = await startServer(home);
  let history: readonly KapTurn[];
  try {
    history = (await subscribe(first, id)).turns(id);
    expect(history, `history written by ${writer}`).toMatchObject([{ status: 'ended', outcome: 'completed', items: [
      { type: 'user_message', text: RELEASED_PROMPT },
      { type: 'assistant_message', text: RELEASED_ANSWER },
    ] }]);
  } finally {
    await first.close();
  }
  const requestsBefore = model.requests('main').length;
  const second = await startServer(home);
  let completed: readonly KapTurn[];
  try {
    expect(second.pid).not.toBe(first.pid);
    const channel = await subscribe(second, id);
    expect(channel.turns(id), `history written by ${writer} after a restart`).toEqual(history);
    model.script(say('The previous greeting is still here.'));
    await second.prompt(id, 'Continue the greeting.');
    await second.waitIdle(id);
    completed = await second.turns(id);
  } finally {
    await second.crash();
  }
  expect(model.requests('main')[requestsBefore]!.texts('assistant'), `context of the turn continuing ${writer}`).toContain(RELEASED_ANSWER);
  expect(completed, `turns continuing ${writer}`).toMatchObject([history[0], { status: 'ended', outcome: 'completed', items: [
    { type: 'user_message', text: 'Continue the greeting.' }, { type: 'assistant_message', text: 'The previous greeting is still here.' },
  ] }]);
  const recovered = await startServer(home);
  try {
    expect(recovered.pid).not.toBe(second.pid);
    expect((await subscribe(recovered, id)).turns(id), `turns continuing ${writer} after a crash`).toEqual(completed);
  } finally {
    await recovered.close();
  }
}

test('every released corpus is complete and unchanged since it was captured', async () => {
  expect(corpora.map(corpus => corpus.version), 'released corpora').not.toEqual([]);
  for (const corpus of corpora) expect(await corpusProblems(corpus), corpus.manifest.writer).toEqual([]);
});

test('[L0:kap.cold-recovery] continues sessions written by every released version in fresh KAP processes and recovers the turn :wait reported idle after a crash', { timeout: CORPUS_TIMEOUT_MS * Math.max(corpora.length, 1) }, async ({ model }) => {
  expect(corpora.map(corpus => corpus.version), 'released corpora').not.toEqual([]);
  await model.listen();
  for (const corpus of corpora) {
    const home = await createTestHome(`cold-recovery-${corpus.version}`);
    try {
      await continueAndRecover(corpus, home, model);
    } finally {
      await home.remove();
    }
  }
});
