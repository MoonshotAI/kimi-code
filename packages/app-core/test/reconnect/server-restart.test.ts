import { TIMEOUTS, until, writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import { KapProcess } from '@moonshot-ai/testkit/kap';
import { fakeModelConfig, say } from '@moonshot-ai/testkit/model';
import { homeFixtures, modelFixtures, type HomeFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { DaemonEventSocket } from '../../src/api/daemon/ws';
import { applyConversationFrame, EMPTY_CONVERSATION, mergeLatestPage, type ConversationFrame, type ConversationView } from '../../src/conversation';

const test = base.extend<HomeFixtures & ModelFixtures>({ ...homeFixtures(), ...modelFixtures() });

function messagesOf(view: ConversationView): string[][] {
  return view.turns.map(turn => turn.items.flatMap(item => item.type === 'user_message' || item.type === 'assistant_message' ? [item.text] : []));
}

test('an open client reconnects by itself when the server is killed and restarted on its port, and keeps following the session', { timeout: 120_000 }, async ({ model, testHome }) => {
  await model.listen();
  await writeKimiConfig(testHome.dataDir, fakeModelConfig(model, { type: 'openai' }));
  const server = await KapProcess.start({ home: testHome });
  const states: boolean[] = [];
  const fatalErrors: string[] = [];
  let snapshots = 0;
  let view: ConversationView = EMPTY_CONVERSATION;
  const socket = new DaemonEventSocket({
    wsUrl: server.wsUrl,
    credentialStore: { getToken: () => server.token },
    handlers: {
      onWireEvent: () => undefined,
      onInteraction: () => undefined,
      onInteractionsReset: () => undefined,
      onConnectionState: connected => states.push(connected),
      onError: (code, msg, fatal) => {
        if (fatal) fatalErrors.push(`${code} ${msg}`);
      },
      onConversation: (_sessionId, _agentId, frame: ConversationFrame) => {
        if (frame.type === 'turns') {
          snapshots += 1;
          view = mergeLatestPage(view, frame);
        } else if (frame.type !== 'turns.failed' && frame.type !== 'notice') {
          view = applyConversationFrame(view, frame);
        }
      },
    },
  });
  try {
    const session = await server.createSession();
    model.script(say('First answer.'));
    await server.prompt(session.id, 'First question.');
    await server.waitIdle(session.id);
    socket.connect();
    socket.subscribeConversation(session.id, 'main');
    await until('the client loaded the first turn', () => snapshots === 1 && view.turns.length === 1);
    const before = view.turns;

    await server.restart('crash');
    await until(
      'the client noticed the restart, reconnected and loaded the session again',
      () => states.includes(false) && states.at(-1) === true && snapshots === 2,
      { timeoutMs: TIMEOUTS.server },
    );
    expect(view.turns).toEqual(before);

    model.script(say('Second answer.'));
    await server.prompt(session.id, 'Second question.');
    await server.waitIdle(session.id);
    await until('the client followed the second turn to its end', () => view.turns.length === 2 && view.turns[1]!.status === 'ended');
    expect(messagesOf(view)).toEqual([['First question.', 'First answer.'], ['Second question.', 'Second answer.']]);
    expect(fatalErrors).toEqual([]);
  } finally {
    socket.close();
    await server.close();
  }
});
