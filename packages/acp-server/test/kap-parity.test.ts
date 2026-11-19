import { readFile } from 'node:fs/promises';

import { startServer, type RunningServer } from '@moonshot-ai/kap-server';
import { writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, say } from '@moonshot-ai/testkit/model';
import { homeFixtures, kapFixtures, useNetworkGuard, type HomeFixtures, type KapFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { createTestClient } from './_helpers/acpClient';

useNetworkGuard();
const test = base.extend<HomeFixtures & KapFixtures<RunningServer>>({ ...homeFixtures(), ...kapFixtures({ startServer }) });

test('KAP and ACP honor the shared first-turn contract and advertise reviewed capabilities', async ({ kap, model, testHome }) => {
  const ledger = JSON.parse(await readFile(new URL('../../../tests/scenarios/capabilities/conversation.json', import.meta.url), 'utf8')) as {
    firstTurn: { prompt: string; answer: string; kap: { terminal: string }; acp: { terminal: string } };
    advertised: { kap: unknown; acp: unknown };
  };
  const { prompt, answer } = ledger.firstTurn;
  model.script(say(answer), say(answer));
  const meta = await kap.rest.get<{ capabilities: unknown }>('/api/v1/meta');
  expect(meta.capabilities, 'KAP advertised capability ledger').toEqual(ledger.advertised.kap);
  const session = await kap.createSession();
  const socket = await kap.connect();
  await socket.subscribe(session.id);
  await kap.prompt(session.id, prompt);
  await kap.waitIdle(session.id);
  await socket.waitFor(frame => frame.type === 'turn.ended' && frame['session_id'] === session.id);
  const [turn] = socket.turns(session.id);
  expect(turn?.['outcome']).toBe(ledger.firstTurn.kap.terminal);
  const kapAnswers = turn?.items.filter(item => item.type === 'assistant_message').map(item => item['text']);
  expect(kapAnswers).toEqual([answer]);

  await writeKimiConfig(testHome.dataDir, fakeModelConfig(model));
  const client = await createTestClient({ homeDir: testHome.dataDir });
  try {
    const init = await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} }) as { agentCapabilities: unknown };
    expect(init.agentCapabilities, 'ACP advertised capability ledger').toEqual(ledger.advertised.acp);
    const { sessionId } = await client.send('session/new', { cwd: testHome.workspace, mcpServers: [] }) as { sessionId: string };
    const result = await client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }) as { stopReason: string };
    expect(result.stopReason).toBe(ledger.firstTurn.acp.terminal);
    const chunks = client.sessionUpdates().map(msg => msg.params as {
      sessionId: string; update: { sessionUpdate: string; content?: { text?: string } };
    }).filter(msg => msg.update.sessionUpdate === 'agent_message_chunk');
    expect(new Set(chunks.map(msg => msg.sessionId))).toEqual(new Set([sessionId]));
    expect(chunks.map(msg => msg.update.content?.text).join('')).toBe(answer);
    expect(model.requests('main').map(request => request.firstUserText)).toEqual([prompt, prompt]);
  } finally {
    await client.close();
  }
}, 30_000);
