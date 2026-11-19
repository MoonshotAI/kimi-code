import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { until, writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import type { KapTurn, KapTurnsPage } from '@moonshot-ai/testkit/kap';
import { fakeModelConfig, say } from '@moonshot-ai/testkit/model';
import { homeFixtures, modelFixtures, type HomeFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { startKapProcess } from './support/kap-process';

const test = base.extend<HomeFixtures & ModelFixtures>({ ...homeFixtures(), ...modelFixtures() });

test('continues a released session across a fresh KAP process and recovers the completed turn after a crash', { timeout: 90_000 }, async ({ model, testHome }) => {
  const root = fileURLToPath(new URL('./fixtures/released-2.6.3/', import.meta.url));
  const fixture: { writer: string; sessionId: string; files: Record<string, string> } = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  expect(fixture.writer).toBe('@moonshot-ai/kimi-code@2.6.3');
  for (const [relative, hash] of Object.entries(fixture.files)) {
    const template = await readFile(join(root, relative), 'utf8');
    expect(createHash('sha256').update(template).digest('hex'), relative).toBe(hash);
    const target = join(testHome.dataDir, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, template.replaceAll('{{DATA_DIR}}', () => JSON.stringify(testHome.dataDir).slice(1, -1))
      .replaceAll('{{WORKSPACE}}', () => JSON.stringify(testHome.workspace).slice(1, -1)));
  }
  await model.listen();
  await writeKimiConfig(testHome.dataDir, fakeModelConfig(model, { type: 'openai' }));
  const id = fixture.sessionId;
  const first = await startKapProcess(testHome);
  let history: readonly KapTurn[];
  try {
    const channel = await first.subscribe(id);
    history = channel.turns(id);
    expect(history, 'released writer history before continuation').toMatchObject([{ status: 'ended', outcome: 'completed', items: [
      { type: 'user_message', text: 'Remember this greeting.' },
      { type: 'assistant_message', text: 'Hello from the released writer.' },
    ] }]);
  } finally {
    await first.close();
  }
  const second = await startKapProcess(testHome);
  let completed: readonly KapTurn[];
  try {
    expect(second.pid).not.toBe(first.pid);
    const channel = await second.subscribe(id);
    expect(channel.turns(id)).toEqual(history);
    model.script(say('The previous greeting is still here.'));
    await second.rest.post(`/api/v1/sessions/${id}/prompts`, { content: [{ type: 'text', text: 'Continue the greeting.' }] });
    await channel.waitFor(f => f.type === 'turn.ended' && f['session_id'] === id);
    const request = model.requests('main')[0]!;
    expect(request.texts('assistant')).toContain('Hello from the released writer.');
    const page = await second.rest.get<KapTurnsPage>(`/api/v1/sessions/${id}/agents/main/turns`);
    completed = page.turns;
    expect(completed).toMatchObject([history[0], { status: 'ended', outcome: 'completed', items: [
      { type: 'user_message', text: 'Continue the greeting.' }, { type: 'assistant_message', text: 'The previous greeting is still here.' },
    ] }]);
    expect(channel.turns(id)).toEqual(completed);
    expect((await second.subscribe(id)).turns(id)).toEqual(completed);
    const wire = Object.keys(fixture.files).find(name => name.endsWith('/agents/main/wire.jsonl'))!;
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
  const recovered = await startKapProcess(testHome);
  try {
    expect(recovered.pid).not.toBe(second.pid);
    expect((await recovered.subscribe(id)).turns(id)).toEqual(completed);
  } finally {
    await recovered.close();
  }
});
