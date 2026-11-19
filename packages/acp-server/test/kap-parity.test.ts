import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { startServer, type RunningServer } from '@moonshot-ai/kap-server';
import { writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, held, say, write } from '@moonshot-ai/testkit/model';
import { homeFixtures, kapFixtures, useNetworkGuard, type HomeFixtures, type KapFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { REJECT_OPTION_ID } from '../src/approval';
import { createTestClient, type TestClient } from './_helpers/acpClient';

useNetworkGuard();
type Fixtures = HomeFixtures & KapFixtures<RunningServer>;
const test = base.extend<Fixtures>({ ...homeFixtures(), ...kapFixtures({ startServer }) });

interface Ledger {
  readonly endings: Readonly<Record<string, { readonly kap: string; readonly acp: string }>>;
  readonly scenarios: readonly { readonly id: string; readonly behavior: string; readonly capabilities: readonly string[] }[];
  readonly divergences: Readonly<Record<string, string>>;
  readonly exempt: Readonly<Record<string, string>>;
  readonly advertised: { readonly kap: unknown; readonly acp: unknown };
}

interface Outcome {
  readonly ending: string;
  readonly answer?: string;
  readonly fileWritten?: boolean;
  readonly modelGotToolResult?: boolean;
}

interface ParityDriver {
  readonly expected: Outcome;
  kap(fixtures: Fixtures): Promise<Outcome>;
  acp(fixtures: Fixtures): Promise<Outcome>;
}

const ledger = JSON.parse(await readFile(new URL('../../../tests/scenarios/capabilities/conversation.json', import.meta.url), 'utf8')) as Ledger;

function endingOf(protocol: 'kap' | 'acp', raw: unknown): string {
  return Object.entries(ledger.endings).find(([, names]) => names[protocol] === raw)?.[0] ?? `unmapped ${protocol} ending ${String(raw)}`;
}

function advertisedPaths(prefix: string, value: unknown): string[] {
  if (value === true) return [prefix];
  if (typeof value !== 'object' || value === null) return [];
  const entries = Object.entries(value);
  return entries.length === 0 ? [prefix] : entries.flatMap(([key, child]) => advertisedPaths(`${prefix}.${key}`, child));
}

async function startAcp(fixtures: Fixtures): Promise<TestClient> {
  await writeKimiConfig(fixtures.testHome.dataDir, fakeModelConfig(fixtures.model));
  return createTestClient({ homeDir: fixtures.testHome.dataDir });
}

async function inAcpSession<T>(fixtures: Fixtures, run: (client: TestClient, sessionId: string) => Promise<T>): Promise<T> {
  const client = await startAcp(fixtures);
  try {
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await client.send('session/new', { cwd: fixtures.testHome.workspace, mcpServers: [] }) as { sessionId: string };
    return await run(client, sessionId);
  } finally {
    await client.close();
  }
}

function acpAnswer(client: TestClient, sessionId: string): string {
  return client.sessionUpdates()
    .map(message => message.params as { sessionId: string; update: { sessionUpdate: string; content?: { text?: string } } })
    .filter(message => message.sessionId === sessionId && message.update.sessionUpdate === 'agent_message_chunk')
    .map(message => message.update.content?.text ?? '')
    .join('');
}

function lastRequestHasToolResult(fixtures: Fixtures): boolean {
  return fixtures.model.requests('main').at(-1)?.view.messages.at(-1)?.role === 'tool';
}

const ANSWER = 'Shared answer.';

const drivers: Readonly<Record<string, ParityDriver>> = {
  'first-turn': {
    expected: { ending: 'answered', answer: ANSWER },
    kap: async ({ kap, model }) => {
      model.script(say(ANSWER));
      const session = await kap.createSession();
      const socket = await kap.connect();
      await socket.subscribe(session.id);
      await kap.prompt(session.id, 'Respond to the shared question.');
      await kap.waitIdle(session.id);
      await socket.waitFor(frame => frame.type === 'turn.ended' && frame['session_id'] === session.id);
      const [turn] = socket.turns(session.id);
      const answer = turn?.items.filter(item => item.type === 'assistant_message').map(item => String(item['text'])).join('');
      return { ending: endingOf('kap', turn?.['outcome']), answer };
    },
    acp: fixtures => inAcpSession(fixtures, async (client, sessionId) => {
      fixtures.model.script(say(ANSWER));
      const result = await client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Respond to the shared question.' }] }) as { stopReason: string };
      return { ending: endingOf('acp', result.stopReason), answer: acpAnswer(client, sessionId) };
    }),
  },
  'cancel-running-turn': {
    expected: { ending: 'cancelled' },
    kap: async ({ kap, model }) => {
      model.script(held('kap-cancel', say('Never finished.')));
      const session = await kap.createSession();
      await kap.prompt(session.id, 'Start and wait.');
      await model.hold('kap-cancel').reached();
      await kap.cancel(session.id);
      model.hold('kap-cancel').release();
      await kap.waitIdle(session.id);
      const [turn] = await kap.turns(session.id);
      return { ending: endingOf('kap', turn?.['outcome']) };
    },
    acp: fixtures => inAcpSession(fixtures, async (client, sessionId) => {
      fixtures.model.script(held('acp-cancel', say('Never finished.')));
      const prompt = client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Start and wait.' }] }) as Promise<{ stopReason: string }>;
      await fixtures.model.hold('acp-cancel').reached();
      client.notify('session/cancel', { sessionId });
      const result = await prompt;
      fixtures.model.hold('acp-cancel').release();
      return { ending: endingOf('acp', result.stopReason) };
    }),
  },
  'reject-file-write': {
    expected: { ending: 'answered', answer: 'Understood.', fileWritten: false, modelGotToolResult: true },
    kap: async fixtures => {
      const { kap, model } = fixtures;
      const target = join(kap.home.workspace, 'parity-kap.txt');
      model.script(write({ path: target, content: 'must not be written' }), say('Understood.'));
      const session = await kap.createSession();
      await kap.prompt(session.id, 'Write the file.', { permissionMode: 'manual' });
      await kap.waitIdle(session.id, {
        onInteraction: async interaction => {
          await kap.answer(session.id, interaction.interaction_id, { kind: 'approval', decision: 'rejected' });
        },
      });
      const [turn] = await kap.turns(session.id);
      const answer = turn?.items.filter(item => item.type === 'assistant_message').map(item => String(item['text'])).join('');
      return { ending: endingOf('kap', turn?.['outcome']), answer, fileWritten: existsSync(target), modelGotToolResult: lastRequestHasToolResult(fixtures) };
    },
    acp: fixtures => inAcpSession(fixtures, async (client, sessionId) => {
      const target = join(fixtures.testHome.workspace, 'parity-acp.txt');
      client.onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected', optionId: REJECT_OPTION_ID } }));
      fixtures.model.script(write({ path: target, content: 'must not be written' }), say('Understood.'));
      const result = await client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Write the file.' }] }) as { stopReason: string };
      return {
        ending: endingOf('acp', result.stopReason),
        answer: acpAnswer(client, sessionId),
        fileWritten: existsSync(target),
        modelGotToolResult: lastRequestHasToolResult(fixtures),
      };
    }),
  },
};

async function runBoth(id: string, fixtures: Fixtures): Promise<{ kap: Outcome; acp: Outcome; expected: Outcome }> {
  const driver = drivers[id];
  if (driver === undefined) throw new Error(`No parity driver for ${id}`);
  return { kap: await driver.kap(fixtures), acp: await driver.acp(fixtures), expected: driver.expected };
}

for (const scenario of ledger.scenarios.filter(({ id }) => ledger.divergences[id] === undefined)) {
  test(`[parity:${scenario.id}] ${scenario.behavior}`, { timeout: 30_000 }, async ({ kap: server, model, testHome }) => {
    const { kap, acp, expected } = await runBoth(scenario.id, { kap: server, model, testHome });
    expect(kap, 'KAP').toEqual(expected);
    expect(acp, 'ACP').toEqual(expected);
  });
}

for (const scenario of ledger.scenarios.filter(({ id }) => ledger.divergences[id] !== undefined)) {
  test(`[parity:${scenario.id}] known divergence: ${scenario.behavior}`, { timeout: 30_000 }, async ({ kap: server, model, testHome }) => {
    const { kap, acp, expected } = await runBoth(scenario.id, { kap: server, model, testHome });
    expect([kap, acp], `${ledger.divergences[scenario.id]}; both protocols now meet the expectation, so remove the entry from divergences`).not.toEqual([expected, expected]);
  });
}

test('every advertised capability has a parity scenario or a reasoned exemption', { timeout: 30_000 }, async ({ kap, model, testHome }) => {
  const fixtures: Fixtures = { kap, model, testHome };
  const meta = await fixtures.kap.rest.get<{ capabilities: unknown }>('/api/v1/meta');
  expect(meta.capabilities, 'KAP advertised capability ledger').toEqual(ledger.advertised.kap);
  const client = await startAcp(fixtures);
  try {
    const init = await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} }) as { agentCapabilities: unknown };
    expect(init.agentCapabilities, 'ACP advertised capability ledger').toEqual(ledger.advertised.acp);
  } finally {
    await client.close();
  }
  const advertised = [...advertisedPaths('kap', ledger.advertised.kap), ...advertisedPaths('acp', ledger.advertised.acp)];
  const compared = new Set(ledger.scenarios.flatMap(scenario => scenario.capabilities));
  expect(advertised.filter(path => !compared.has(path) && (ledger.exempt[path] ?? '').trim() === ''), 'advertised without a parity scenario or an exemption').toEqual([]);
  expect([...compared, ...Object.keys(ledger.exempt)].filter(path => !advertised.includes(path)), 'scenario or exemption naming a capability nobody advertises').toEqual([]);
  expect(Object.keys(ledger.divergences).filter(id => !ledger.scenarios.some(scenario => scenario.id === id)), 'divergence for an unknown scenario').toEqual([]);
  expect(Object.values(ledger.divergences).filter(reason => reason.trim() === ''), 'divergence without a reason').toEqual([]);
  expect(ledger.scenarios.map(scenario => scenario.id).toSorted(), 'scenarios and drivers').toEqual(Object.keys(drivers).toSorted());
});
