import { describe, expect, it } from 'vitest';

import type { LlmRequest } from '#/llm/request';
import { mergeFields, type LlmRequestPart } from '#/llm/requester';
import type { LoopLlmRequester } from '#/loop/index';
import { SessionError } from '#/session/index';
import type { ToolResult } from '#/tool/index';

import {
  agentCaps,
  echoRequester,
  loopEvent,
  noopExecutor,
  scriptedRequester,
  testSession,
  textOutcome,
  texts,
  user,
} from '../app/fake-llm';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function profileRequester(defaults: LlmRequestPart, seen: unknown[]): LoopLlmRequester {
  const build = (filled: LlmRequestPart): LoopLlmRequester => ({
    with: (part) =>
      build(mergeFields(filled as Record<string, unknown>, part as Record<string, unknown>) as LlmRequestPart),
    request: (rest) =>
      mergeFields(filled as Record<string, unknown>, rest as Record<string, unknown>) as unknown as LlmRequest,
    generate: async (rest: GenerateRest) => {
      const merged = mergeFields(filled as Record<string, unknown>, rest as Record<string, unknown>);
      seen.push(merged?.['profile']);
      return textOutcome('ok');
    },
  });
  return build(defaults);
}

describe('session', () => {
  it('registers agents once, restores them across reopen and resumes an interrupted turn', async () => {
    const logs = new Map<string, string[]>();
    const first = await testSession(logs);
    const [main, again] = await Promise.all([
      first.open('main', agentCaps(), { source: 'cli' }),
      first.open('main', agentCaps()),
    ]);
    expect(main).toBe(again);
    expect(main.reopened).toBe(false);
    await expect(first.open('bad/id', agentCaps())).rejects.toMatchObject({ reason: 'invalid-agent' });
    await main.loop.runTurn(user('hello'));
    await first.close();
    const second = await testSession(logs);
    expect(second.roster.getState()).toEqual({ agents: { main: { source: 'cli' } } });
    const restored = await second.open('main', agentCaps());
    expect(restored.reopened).toBe(true);
    expect(texts(restored)).toEqual(['hello', 'echo:hello']);
    expect(restored.loop.state.messages).toEqual(restored.view.getState().messages);
    expect(restored.loop.state.nextTurnId).toBe(1);

    const hanging = { execute: () => new Promise<ToolResult>(() => {}) };
    const slow = scriptedRequester(() =>
      textOutcome('', [{ type: 'function', id: 'call-1', name: 'slow', arguments: '{}' }]),
    );
    const worker = await second.open('worker', agentCaps(hanging, slow));
    const started = loopEvent(worker.loop, 'tool.started');
    worker.loop.submit(user('work'));
    await started;
    await worker.flush();
    const crashed = new Map([...logs].map(([name, lines]) => [name, [...lines]]));
    await second.close();

    const third = await testSession(logs);
    const closed = await third.open('worker', agentCaps(hanging, echoRequester()));
    expect(closed.loop.state.status).toBe('idle');
    expect(texts(closed)).toEqual(['work', '', 'aborted']);
    expect(closed.view.getState().turns.map((turn) => turn.outcome?.type)).toEqual(['aborted']);
    await third.close();

    const fourth = await testSession(crashed);
    const resumed = await fourth.open('worker', agentCaps(hanging, scriptedRequester(() => textOutcome('after'))));
    expect(resumed.loop.state).toMatchObject({ status: 'interrupted', nextTurnId: 1, turn: { id: 0, step: 1 } });
    await expect(fourth.undo('worker', 1)).rejects.toMatchObject({ reason: 'busy' });
    const ended = loopEvent(resumed.loop, 'turn.ended');
    resumed.loop.continue();
    expect(await ended).toMatchObject({ turnId: 0, outcome: { type: 'done' } });
    await resumed.flush();
    expect(texts(resumed)).toEqual(['work', '', 'aborted', 'after']);
    expect(resumed.loop.state.messages).toEqual(resumed.view.getState().messages);
    expect(resumed.view.getState()).toMatchObject({ nextTurnId: 1, turns: [{ turnId: 0, outcome: { type: 'done' } }] });
    expect(resumed.log.replica.entries().map((entry) => entry.event.type)).toContain('turn.resumed');
    await fourth.close();
  });

  it('undoes whole turns by rewinding the agent log and resetting its live loop', async () => {
    const opened = await testSession();
    const main = await opened.open('main', agentCaps());
    for (const text of ['one', 'two', 'three']) await main.loop.runTurn(user(text));
    await opened.undo('main', 2);
    expect(texts(main)).toEqual(['one', 'echo:one']);
    expect(main.loop.state.messages).toEqual(main.view.getState().messages);
    expect(main.view.getState().turns.map((position) => position.turnId)).toEqual([0]);
    await main.loop.runTurn(user('again'));
    await main.flush();
    expect(texts(main)).toEqual(['one', 'echo:one', 'again', 'echo:again']);
    await expect(opened.undo('main', 3)).rejects.toMatchObject({ reason: 'insufficient' });
    await expect(opened.undo('main', 0)).rejects.toMatchObject({ reason: 'invalid-count' });
    await expect(opened.undo('ghost', 1)).rejects.toMatchObject({ reason: 'unknown-agent' });
    await opened.close();
  });

  it('forks into a self-contained log', async () => {
    const logs = new Map<string, string[]>();
    const first = await testSession(logs);
    const main = await first.open('main', agentCaps());
    await main.loop.runTurn(user('one'));
    await main.loop.runTurn(user('two'));
    await first.undo('main', 1);
    const child = await first.fork('main', 'child', agentCaps(), { source: 'task' });
    expect(texts(child)).toEqual(['one', 'echo:one']);
    expect(child.loop.state.messages).toEqual(main.loop.state.messages);
    await expect(first.fork('main', 'child', agentCaps())).rejects.toBeInstanceOf(SessionError);
    await expect(first.fork('ghost', 'other', agentCaps())).rejects.toMatchObject({ reason: 'unknown-agent' });
    const version = main.log.version;
    await first.close();
    logs.delete('agents/main');
    const second = await testSession(logs);
    expect(texts(await second.open('child', agentCaps()))).toEqual(['one', 'echo:one']);
    expect(second.roster.getState().agents['child']).toEqual({
      source: 'task',
      forkedFrom: { agentId: 'main', version },
    });
  });

  it('registers orphan agent logs on open', async () => {
    const logs = new Map([['agents/orphan', ['{"seq":0,"time":1,"events":[{"type":"turn.started","turnId":0,"trigger":"normal"}]}']]]);
    const opened = await testSession(logs);
    expect(opened.roster.getState().agents).toEqual({ orphan: {} });
  });

  it('persists the loop profile across reopen, overrides requester defaults, and replays it on undo', async () => {
    const logs = new Map<string, string[]>();
    const tool = { name: 'lookup', description: 'Find things', parameters: { type: 'object', properties: {} } };
    const seen: unknown[] = [];
    const caps = () => agentCaps(noopExecutor, profileRequester({ profile: { systemPrompt: 'fresh-default' } }, seen));

    const first = await testSession(logs);
    const main = await first.open('main', caps());
    expect(main.loop.setSystemPrompt('frozen-sp')?.type).toBe('system_prompt.settled');
    expect(main.loop.setTools([tool])?.type).toBe('tools.settled');
    await main.loop.runTurn(user('one'));
    expect(seen.at(-1)).toMatchObject({ systemPrompt: 'frozen-sp', tools: [tool] });
    await first.close();

    const second = await testSession(logs);
    const restored = await second.open('main', caps());
    expect(restored.reopened).toBe(true);
    expect(restored.loop.state.profile).toEqual({ systemPrompt: 'frozen-sp', tools: [tool] });
    expect(restored.view.getState().profile).toEqual(restored.loop.state.profile);
    await restored.loop.runTurn(user('two'));
    expect(seen.at(-1)).toMatchObject({ systemPrompt: 'frozen-sp', tools: [tool] });

    const settledCount = async () => {
      await restored.flush();
      return restored.log.replica.entries().filter((entry) => entry.event.type === 'system_prompt.settled').length;
    };
    restored.loop.setSystemPrompt('sp-v2');
    await restored.loop.runTurn(user('three'));
    expect(await settledCount()).toBe(2);
    await second.undo('main', 1);
    expect(restored.loop.state.profile.systemPrompt).toBe('sp-v2');
    expect(await settledCount()).toBe(2);

    restored.loop.setSystemPrompt('sp-v3');
    await restored.loop.runTurn(user('four'));
    restored.loop.setSystemPrompt('sp-v4');
    await second.undo('main', 1);
    expect(restored.loop.state.profile.systemPrompt).toBe('sp-v3');
    expect(restored.view.getState().profile).toEqual(restored.loop.state.profile);
    expect(await settledCount()).toBe(4);
    expect(texts(restored)).toEqual(['one', 'ok', 'two', 'ok']);
    await second.close();
  });
});
