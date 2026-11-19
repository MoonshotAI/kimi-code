import { writeKimiConfig, type TestHome } from '@moonshot-ai/testkit/fixtures';
import { KapProcess, type KapSocket, type KapTurn } from '@moonshot-ai/testkit/kap';
import { fakeModelConfig, say } from '@moonshot-ai/testkit/model';
import { homeFixtures, modelFixtures, type HomeFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { corpusProblems, installCorpus, releasedCorpora, RELEASED_ANSWER, RELEASED_PROMPT } from './support/released-corpus';

const test = base.extend<HomeFixtures & ModelFixtures>({ ...homeFixtures(), ...modelFixtures() });
const corpora = await releasedCorpora();

function startServer(home: TestHome): Promise<KapProcess> {
  return KapProcess.start({ home, env: { KIMI_CODE_PERSISTENCE_MINIDB_READMODEL: undefined } });
}

async function subscribe(server: KapProcess, sessionId: string): Promise<KapSocket> {
  const socket = await server.connect();
  await socket.subscribe(sessionId);
  return socket;
}

test('every released corpus is complete and unchanged since it was captured', async () => {
  expect(corpora.map(corpus => corpus.version), 'released corpora').not.toEqual([]);
  for (const corpus of corpora) expect(await corpusProblems(corpus), corpus.manifest.writer).toEqual([]);
});

for (const corpus of corpora) {
  test(`continues a session written by ${corpus.manifest.writer} across a fresh KAP process and recovers the completed turn after a crash right after :wait reports idle`, { timeout: 90_000 }, async ({ model, testHome }) => {
    await installCorpus(corpus, testHome);
    await model.listen();
    await writeKimiConfig(testHome.dataDir, fakeModelConfig(model, { type: 'openai' }));
    const id = corpus.manifest.sessionId;
    const first = await startServer(testHome);
    let history: readonly KapTurn[];
    try {
      history = (await subscribe(first, id)).turns(id);
      expect(history, 'released writer history before continuation').toMatchObject([{ status: 'ended', outcome: 'completed', items: [
        { type: 'user_message', text: RELEASED_PROMPT },
        { type: 'assistant_message', text: RELEASED_ANSWER },
      ] }]);
    } finally {
      await first.close();
    }
    const second = await startServer(testHome);
    let completed: readonly KapTurn[];
    try {
      expect(second.pid).not.toBe(first.pid);
      const channel = await subscribe(second, id);
      expect(channel.turns(id)).toEqual(history);
      model.script(say('The previous greeting is still here.'));
      await second.prompt(id, 'Continue the greeting.');
      await second.waitIdle(id);
      completed = await second.turns(id);
    } finally {
      await second.crash();
    }
    expect(model.requests('main')[0]!.texts('assistant')).toContain(RELEASED_ANSWER);
    expect(completed).toMatchObject([history[0], { status: 'ended', outcome: 'completed', items: [
      { type: 'user_message', text: 'Continue the greeting.' }, { type: 'assistant_message', text: 'The previous greeting is still here.' },
    ] }]);
    const recovered = await startServer(testHome);
    try {
      expect(recovered.pid).not.toBe(second.pid);
      expect((await subscribe(recovered, id)).turns(id)).toEqual(completed);
    } finally {
      await recovered.close();
    }
  });
}
