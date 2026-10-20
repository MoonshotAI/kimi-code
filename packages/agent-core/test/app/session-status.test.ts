import { describe, expect, it } from 'vitest';

import { createApp, type App } from '#/app/index';
import type { LlmRequest } from '#/llm/request';
import type { LoopLlmRequester } from '#/loop/index';
import { MAIN_AGENT_ID, memorySessionSpace, type Agent, type Session } from '#/session/index';

import { agentCaps, loopEvent, noopExecutor, textOutcome, user } from './fake-llm';

type Step = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'fail' } | { readonly kind: 'hang' };

let queue: Step[] = [];

function createMockRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (_rest, control) => {
      const step: Step = queue.shift() ?? { kind: 'text', text: 'done' };
      if (step.kind === 'hang') {
        return new Promise((_, reject) => {
          control.signal.addEventListener('abort', () => {
            reject(control.signal.reason);
          });
        });
      }
      if (step.kind === 'fail') throw new Error('boom');
      return textOutcome(step.text);
    },
  };
  return self;
}

async function startTest(): Promise<{
  app: App;
  space: ReturnType<typeof memorySessionSpace>;
  session: Session;
  main: Agent;
}> {
  const space = memorySessionSpace();
  const app = createApp({ space });
  const session = await app.create({});
  const main = await session.open(MAIN_AGENT_ID, agentCaps(noopExecutor, createMockRequester()));
  return { app, space, session, main };
}

describe('session.status', () => {
  it('derives the last turn outcome from the main agent log and ignores other agents', async () => {
    const { app, session, main } = await startTest();
    queue = [{ kind: 'text', text: 'hi' }];
    await main.loop.runTurn(user('go'));
    await main.flush();
    expect(session.status()).toEqual({
      busy: false,
      mainTurnActive: false,
      source: 'startup',
      lastTurnReason: 'completed',
    });
    const sub = await session.open('sub', agentCaps(noopExecutor, createMockRequester()));
    queue = [{ kind: 'fail' }];
    await sub.loop.runTurn(user('go'));
    await sub.flush();
    expect(session.status().lastTurnReason).toBe('completed');
    await app.close();
  });

  it('maps failed and aborted outcomes, tracks busy while a turn is running, and keeps the previous outcome', async () => {
    const { app, session, main } = await startTest();
    queue = [{ kind: 'fail' }];
    const failed = await main.loop.runTurn(user('go'));
    expect(failed.type).toBe('failed');
    await main.flush();
    expect(session.status().lastTurnReason).toBe('failed');
    queue = [{ kind: 'hang' }];
    const started = loopEvent(main.loop, 'turn.started');
    main.loop.submit(user('again'));
    await started;
    expect(session.status()).toEqual({
      busy: true,
      mainTurnActive: true,
      source: 'startup',
      lastTurnReason: 'failed',
    });
    const ended = loopEvent(main.loop, 'turn.ended');
    main.loop.abort();
    await ended;
    await main.flush();
    expect(session.status().lastTurnReason).toBe('cancelled');
    await app.close();
  });

  it('follows the surviving branch after undo', async () => {
    const { app, session, main } = await startTest();
    queue = [{ kind: 'text', text: 'one' }];
    await main.loop.runTurn(user('one'));
    queue = [{ kind: 'fail' }];
    await main.loop.runTurn(user('two'));
    await main.flush();
    expect(session.status().lastTurnReason).toBe('failed');
    await session.undo(MAIN_AGENT_ID, 1);
    expect(session.status().lastTurnReason).toBe('completed');
    expect(session.agents.get(MAIN_AGENT_ID)).toBe(main);
    await app.close();
  });

  it('is available right after reopen without opening the main agent', async () => {
    const { app, space, session, main } = await startTest();
    queue = [{ kind: 'text', text: 'hi' }];
    await main.loop.runTurn(user('go'));
    const sessionId = session.id;
    await app.close();
    expect((await space.get(sessionId))?.lastTurn).toEqual({ turnId: 0, outcome: 'done' });
    const reopened = createApp({ space });
    const session2 = await reopened.create({ sessionId });
    expect(session2.agents.size).toBe(0);
    expect(session2.status()).toEqual({
      busy: false,
      mainTurnActive: false,
      source: 'resume',
      lastTurnReason: 'completed',
    });
    await reopened.close();
  });
});
