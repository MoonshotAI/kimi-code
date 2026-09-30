import { describe, expect, it } from 'vitest';

import { createHarness, memorySessionSpace, type AgentHandle, type AppHandle, type SessionHandle, type SessionStatus } from '#/app/index';
import { undo, UndoRef } from '#/builtin/undo/index';
import { createFeature, MAIN_AGENT_ID, useAgent } from '#/feature/index';
import { createUserMessage } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type Step = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'fail' } | { readonly kind: 'hang' };

let queue: Step[] = [];

function createMockRequester(): LlmRequester {
  return {
    generate: async (_config, _content, { onEvent, signal }) => {
      const step: Step = queue.shift() ?? { kind: 'text', text: 'done' };
      if (step.kind === 'hang') {
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason);
          });
        });
        return;
      }
      if (step.kind === 'fail') throw new Error('boom');
      onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: step.text } });
      onEvent?.({ type: 'llm.done' });
    },
  };
}

function bindTestLlm(requester: LlmRequester) {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

async function startTest(): Promise<{
  app: AppHandle;
  space: ReturnType<typeof memorySessionSpace>;
  session: SessionHandle;
  main: AgentHandle;
}> {
  const space = memorySessionSpace();
  const app = createHarness({ space, features: [undo, bindTestLlm(createMockRequester())] });
  await app.ready();
  const session = await app.open({});
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'host' });
  await main.ready();
  return { app, space, session, main };
}

async function statusOf(session: SessionHandle): Promise<SessionStatus> {
  await session.stores.flush();
  return session.status();
}

describe('session.status', () => {
  it('folds the main agent turn outcome into the session journal and ignores other agents', async () => {
    const { app, session, main } = await startTest();
    queue = [{ kind: 'text', text: 'hi' }];
    await main.run(createUserMessage('go'));

    expect(await statusOf(session)).toEqual({ busy: false, mainTurnActive: false, source: 'startup', lastTurnReason: 'completed' });

    const sub = await session.create({ agentId: 'sub' });
    await sub.ready();
    queue = [{ kind: 'text', text: 'sub' }];
    await sub.run(createUserMessage('go'));
    expect((await statusOf(session)).lastTurnReason).toBe('completed');

    await app.disposeAsync();
  });

  it('maps failed and aborted outcomes, tracks busy while a turn is running, and keeps the previous outcome', async () => {
    const { app, session, main } = await startTest();
    queue = [{ kind: 'fail' }];
    const failed = await main.run(createUserMessage('go'));
    expect(failed.outcome.type).toBe('failed');
    expect((await statusOf(session)).lastTurnReason).toBe('failed');

    queue = [{ kind: 'hang' }];
    const started = session.wait('turn.started');
    main.submit(createUserMessage('again'));
    await started;
    expect(await statusOf(session)).toEqual({ busy: true, mainTurnActive: true, source: 'startup', lastTurnReason: 'failed' });

    const done = main.wait('turn.done');
    main.abort();
    await done;
    expect((await statusOf(session)).lastTurnReason).toBe('cancelled');

    await app.disposeAsync();
  });

  it('seeds the surviving branch outcome after undo remount', async () => {
    const { app, session, main } = await startTest();
    queue = [{ kind: 'text', text: 'one' }];
    await main.run(createUserMessage('one'));
    queue = [{ kind: 'fail' }];
    await main.run(createUserMessage('two'));
    expect((await statusOf(session)).lastTurnReason).toBe('failed');

    const undone = await main.resolve(UndoRef)!.undo(1);
    expect(undone).toBe(1);
    expect((await statusOf(session)).lastTurnReason).toBe('completed');

    await app.disposeAsync();
  });

  it('is available right after reopen without opening the main agent store', async () => {
    const { app, space, session, main } = await startTest();
    queue = [{ kind: 'text', text: 'hi' }];
    await main.run(createUserMessage('go'));
    const sessionId = session.sessionId;
    const branch = session.stores.branch(MAIN_AGENT_ID);
    await app.disposeAsync();

    const app2 = createHarness({
      space,
      features: [bindTestLlm(createMockRequester())],
    });
    await app2.ready();
    const session2 = await app2.open({ sessionId });
    expect(session2.list()).toEqual([]);
    expect(await statusOf(session2)).toEqual({ busy: false, mainTurnActive: false, source: 'resume', lastTurnReason: 'completed' });
    expect(session2.list()).toEqual([]);
    expect(session2.stores.get(MAIN_AGENT_ID)).toBeUndefined();
    expect(session2.stores.session.getState().roster.agents[MAIN_AGENT_ID]?.branch).toBe(branch);

    await app2.disposeAsync();
  });
});
