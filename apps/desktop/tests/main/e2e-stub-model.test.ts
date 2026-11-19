import { afterEach, describe, expect, it, vi } from 'vitest';

import { after, held, messageProblems, say, startStubModel, StubModelClosedError, type ChatMessage, type StubModel } from '../../e2e/fixtures/model';

let model: StubModel | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await model?.close();
  model = undefined;
});

describe('stub model holds', () => {
  it('rejects a hold name reused within one script call', async () => {
    model = await startStubModel();
    expect(() => model!.script(held('gate', say(['a'])), held('gate', say(['b'])))).toThrow(/Hold "gate" is already used/);
  });

  it('rejects a hold name reused across script calls', async () => {
    model = await startStubModel();
    model.script(held('gate', say(['a'])));
    expect(() => model!.script(held('gate', say(['b'])))).toThrow(/Hold "gate" is already used/);
  });

  it('still lets a test look up a hold before scripting it', async () => {
    model = await startStubModel();
    model.hold('gate');
    expect(() => model!.script(held('gate', say(['a'])))).not.toThrow();
  });
});

const watchTimer = (delayMs: number): { readonly cleared: () => boolean } => {
  const created: unknown[] = [];
  const cleared = new Set<unknown>();
  const setTimer = globalThis.setTimeout;
  const clearTimer = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
    const timer = setTimer(handler, ms);
    if (ms === delayMs) created.push(timer);
    return timer;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer?: Parameters<typeof clearTimeout>[0]) => {
    cleared.add(timer);
    clearTimer(timer);
  }) as typeof clearTimeout);
  return { cleared: () => created.length === 1 && cleared.has(created[0]) };
};

const send = (stub: StubModel, signal?: AbortSignal): Promise<Response> =>
  fetch(`${stub.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tools: [{ function: { name: 'Bash' } }], messages: [{ role: 'user', content: 'hi' }] }),
    signal,
  });

const settled = async (ready: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
};

describe('stub model aborts', () => {
  it('skips a later hold when the client aborts before reaching it', async () => {
    model = await startStubModel();
    model.script(held('gate', say(['a', 'b', 'c'], { intervalMs: 300 }), 1));
    const controller = new AbortController();
    const response = await send(model, controller.signal);
    await response.body!.getReader().read();
    controller.abort();
    await settled(() => model!.aborts() === 1);
    expect(model.aborts()).toBe(1);
    await expect(model.hold('gate').reached(800)).rejects.toThrow(/No stub model request reached hold "gate"/);
    expect(model.heldTurns()).toBe(0);
  });

  it('clears a response delay when the client aborts', async () => {
    model = await startStubModel();
    const timer = watchTimer(60_000);
    model.script(after(60_000, say(['late'])));
    const controller = new AbortController();
    const pending = send(model, controller.signal).catch(() => undefined);
    await model.waitForRequest(0);
    controller.abort();
    await pending;
    await settled(() => model!.aborts() === 1 && timer.cleared());
    expect(timer.cleared()).toBe(true);
  });

  it('clears a response delay when the model closes', async () => {
    model = await startStubModel();
    const timer = watchTimer(60_000);
    model.script(after(60_000, say(['late'])));
    const pending = send(model).catch(() => undefined);
    await model.waitForRequest(0);
    await model.close();
    model = undefined;
    await pending;
    expect(timer.cleared()).toBe(true);
  });
});

describe('stub model waiters on close', () => {
  it('settles pending waiters and clears their timers when the model closes', async () => {
    model = await startStubModel();
    const timer = watchTimer(60_000);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const reached = model.hold('gate').reached(60_000);
    const request = model.waitForRequest(0, 61_000);
    const heldTurn = model.waitForHeldTurn(62_000);
    await model.close();
    model = undefined;
    await expect(reached).rejects.toBeInstanceOf(StubModelClosedError);
    await expect(request).rejects.toBeInstanceOf(StubModelClosedError);
    await expect(heldTurn).rejects.toBeInstanceOf(StubModelClosedError);
    expect(timer.cleared()).toBe(true);
    process.off('unhandledRejection', unhandled);
  });

  it('does not raise an unhandled rejection for an abandoned waiter', async () => {
    model = await startStubModel();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    void model.hold('gate').reached(60_000);
    await model.close();
    model = undefined;
    await new Promise(resolve => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('messageProblems tool ordering', () => {
  const callMessage: ChatMessage = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: '{}' } }] };
  const result: ChatMessage = { role: 'tool', tool_call_id: 'c1', content: 'ok' };

  it('accepts a tool result right after its call', () => {
    expect(messageProblems([{ role: 'user', content: 'hi' }, callMessage, result, { role: 'user', content: 'next' }])).toEqual([]);
  });

  it('flags a user message between a tool call and its result', () => {
    expect(messageProblems([{ role: 'user', content: 'hi' }, callMessage, { role: 'user', content: 'steer' }, result]))
      .toEqual(['messages[2] (user) arrives before the results of tool calls c1']);
  });

  it('flags an assistant message between a tool call and its result', () => {
    expect(messageProblems([{ role: 'user', content: 'hi' }, callMessage, { role: 'assistant', content: 'more' }, result]))
      .toEqual(['messages[2] (assistant) arrives before the results of tool calls c1']);
  });
});
