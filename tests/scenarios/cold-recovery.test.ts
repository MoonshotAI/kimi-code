import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { until, writeKimiConfig, type TestHome } from '@moonshot-ai/testkit/fixtures';
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
  test(`continues a session written by ${corpus.manifest.writer} across a fresh KAP process and recovers the completed turn after a crash`, { timeout: 90_000 }, async ({ model, testHome }) => {
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
      await channel.waitFor(f => f.type === 'turn.ended' && f['session_id'] === id);
      const request = model.requests('main')[0]!;
      expect(request.texts('assistant')).toContain(RELEASED_ANSWER);
      completed = await second.turns(id);
      expect(completed).toMatchObject([history[0], { status: 'ended', outcome: 'completed', items: [
        { type: 'user_message', text: 'Continue the greeting.' }, { type: 'assistant_message', text: 'The previous greeting is still here.' },
      ] }]);
      expect(channel.turns(id)).toEqual(completed);
      expect((await subscribe(second, id)).turns(id)).toEqual(completed);
      const wire = Object.keys(corpus.manifest.files).find(name => name.endsWith('/agents/main/wire.jsonl'))!;
      await until('continued turn.ended persisted to the session wire before abrupt process loss', async () => {
        const content = await readFile(join(testHome.dataDir, wire), 'utf8');
        return content.trimEnd().split('\n').some(line => {
          const event = JSON.parse(line) as { type: string; turnId?: number; reason?: string };
          return event.type === 'turn.ended' && event.turnId === completed.at(-1)?.['turn_number'] && event.reason === 'completed';
        });
      });
    } finally {
      await second.crash();
    }
    const recovered = await startServer(testHome);
    try {
      expect(recovered.pid).not.toBe(second.pid);
      expect((await subscribe(recovered, id)).turns(id)).toEqual(completed);
    } finally {
      await recovered.close();
    }
  });
}
