import { assign, createMachine, fromCallback } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { AgentSpaceImpl } from '#/agent/agentContext/agentSpace';
import {
  defineAgentRuntime,
  type AgentRuntimeDefinition,
  type AgentRuntimeDefinitionRecord,
  type AgentRuntimeDescriptor,
  type AgentRuntimeRestoreEvent,
  type DurableAgentRuntimeParticipant,
} from '#/agent/runtime/agentRuntime';
import { AgentRuntimeSet } from '#/agent/runtime/agentRuntimeSet';
import type { DurableRuntimeParticipantHost } from '#/state/eventDispatcher';

const agent = { agentId: 'main', generation: 1, space: {} } as AgentContext;
const accessor = { get: vi.fn() } as unknown as ServicesAccessor;

function record<Runtime>(
  id: string,
  createApi: AgentRuntimeDescriptor<any, Runtime>['createApi'] = () => ({}) as Runtime,
  generation = 1,
  logic: AgentRuntimeDescriptor<any, any>['logic'] = fromCallback(() => {}),
  durable?: AgentRuntimeDescriptor<any, any>['durable'],
): AgentRuntimeDefinitionRecord & { definition: AgentRuntimeDefinition<any, Runtime> } {
  return {
    definition: defineAgentRuntime({ id, logic, durable, createApi }),
    generation,
    active: true,
  };
}

function host<T extends DurableRuntimeParticipantHost['attach']>(
  attach: T,
): DurableRuntimeParticipantHost & { attach: T } {
  return { attach };
}

describe('AgentRuntimeSet', () => {
  it('exposes an opaque definition token while preserving typed resolution', async () => {
    const runtime = record('opaque', () => ({ read: () => 42 }));
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(runtime);

    expect(Object.keys(runtime.definition)).toEqual([]);
    expect(runtime.definition).not.toHaveProperty('id');
    expect(runtime.definition).not.toHaveProperty('logic');
    expect(runtime.definition).not.toHaveProperty('createApi');
    expect(runtime.definition).not.toHaveProperty('durable');
    expect(runtime.definition).not.toHaveProperty('inspect');
    expect(runtime.definition).not.toHaveProperty('eager');
    expect(runtime.definition).not.toHaveProperty('input');
    expect(set.resolve(runtime.definition).read()).toBe(42);
    await set.close();
  });

  it('materializes lazily and cleans up the actor when runtimeInstance creation fails', async () => {
    let stopped = 0;
    const runtime = record(
      'failing',
      () => { throw new Error('runtimeInstance failed'); },
      1,
      fromCallback(() => () => { stopped += 1; }),
    );
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(runtime);

    expect(() => set.resolve(runtime.definition)).toThrow('runtimeInstance failed');
    expect(() => set.resolve(runtime.definition)).toThrow('runtimeInstance failed');
    expect(set.inspect()[0]).toMatchObject({ status: 'failed', error: 'runtimeInstance failed' });
    await set.close();
    expect(stopped).toBe(1);
    expect(set.inspect()[0]).toMatchObject({ id: 'failing', status: 'retired', error: 'runtimeInstance failed' });
    return set.close();
  });

  it('keeps runtimes alive when the compatibility AgentSpace is killed', async () => {
    let stopped = 0;
    const space = new AgentSpaceImpl('main');
    const context = Object.freeze({ agentId: 'main', generation: 1, space });
    space._bindContext(context);
    const runtime = record(
      'space-independent',
      () => ({ value: 1 }),
      1,
      fromCallback(() => () => { stopped += 1; }),
    );
    const set = new AgentRuntimeSet(context, accessor);
    set.apply(runtime);
    const runtimeInstance = set.resolve(runtime.definition);

    space._kill();

    expect(runtimeInstance.value).toBe(1);
    expect(set.resolve(runtime.definition)).toBe(runtimeInstance);
    expect(stopped).toBe(0);
    await set.close();
    expect(stopped).toBe(1);
  });

  it('records actor failure and closes the failed runtime safely', async () => {
    const runtime = record(
      'actor-failure',
      undefined,
      1,
      fromCallback(() => { throw new Error('actor failed'); }),
    );
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(runtime);
    set.resolve(runtime.definition);
    await Promise.resolve();

    expect(set.inspect()[0]).toMatchObject({ status: 'failed', error: 'actor failed' });
    await set.close();
    await set.close();
    expect(set.inspect()[0]).toMatchObject({ status: 'retired', error: 'actor failed' });
  });

  it('attaches each durable runtime only once and detaches it on close', async () => {
    const attach = vi.fn(() => ({ dispose: vi.fn() }));
    const set = new AgentRuntimeSet(agent, accessor);
    const runtime = record('durable', undefined, 1, undefined, {
      events: [],
      undoable: false,
      transition: () => {},
      read: () => undefined,
      commit: () => {},
    });
    set.apply(runtime);
    const participantHost = host(attach);
    set.attachDurable(participantHost);
    set.attachDurable(participantHost);

    expect(attach).toHaveBeenCalledTimes(1);
    await set.close();
    expect(attach.mock.results[0]!.value.dispose).toHaveBeenCalledTimes(1);
  });

  it('sends restore once and waits for actor readiness', async () => {
    let restores = 0;
    let release!: () => void;
    const runtime = record(
      'restore-ready',
      undefined,
      1,
      fromCallback(({ receive }) => {
        receive((event) => {
          const restore = event as AgentRuntimeRestoreEvent;
          if (restore.type !== 'runtime.restore') return;
          restores += 1;
          restore.waitUntil(new Promise<void>((resolve) => { release = resolve; }));
        });
      }),
      {
        events: [],
        undoable: false,
        transition: () => {},
        read: () => undefined,
        commit: () => {},
      },
    );
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(runtime);
    set.attachDurable(host(vi.fn(() => ({ dispose: vi.fn() }))));

    let ready = false;
    const first = set.restore().then(() => { ready = true; });
    const second = set.restore();
    await Promise.resolve();

    expect(restores).toBe(1);
    expect(ready).toBe(false);

    release();
    await Promise.all([first, second, set.restore()]);

    expect(restores).toBe(1);
    expect(ready).toBe(true);
    await set.close();
  });

  it('keeps synchronous restore failures rejected on repeated restore', async () => {
    const error = new Error('restore send failed');
    const entry = {
      actor: { send: vi.fn(() => { throw error; }) },
      restored: false,
      status: 'materialized',
    };
    const set = new AgentRuntimeSet(agent, accessor);
    const restoreEntry = (set as unknown as { restoreEntry(entry: never): Promise<void> }).restoreEntry.bind(set);

    const first = restoreEntry(entry as never);
    await expect(first).rejects.toBe(error);
    expect(entry).toMatchObject({ restored: true, status: 'failed' });

    const second = restoreEntry(entry as never);
    await expect(second).rejects.toBe(error);
    expect(entry.actor.send).toHaveBeenCalledTimes(1);
  });

  it('disposes change listeners independently', async () => {
    let participant: { commit(state: number): void } | undefined;
    const runtime = record(
      'listeners',
      (context) => ({ onDidChange: context.onDidChange }),
      1,
      createMachine({
        context: { value: 0 },
        on: {
          commit: {
            actions: assign({ value: ({ event }) => event.value }),
          },
        },
      }),
      {
        events: [],
        undoable: false,
        transition: () => {},
        read: (snapshot) => (snapshot as unknown as { context: { value: number } }).context.value,
        commit: (actor, state) => { actor.send({ type: 'commit', value: state }); },
      },
    );
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(runtime);
    set.attachDurable(host(vi.fn((attached: DurableAgentRuntimeParticipant) => {
      participant = attached;
      return { dispose: vi.fn() };
    })));
    const runtimeInstance = set.resolve(runtime.definition);
    const listener = vi.fn();
    const subscription = runtimeInstance.onDidChange(listener);

    participant!.commit(1);
    subscription.dispose();
    participant!.commit(2);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1);
    await set.close();
  });

  it('drains a tracked lease before disposing the actor', async () => {
    let stopped = 0;
    let release!: () => void;
    const runtime = record(
      'leased',
      (context) => ({
        run: () => context.track(new Promise<void>((resolve) => { release = resolve; })),
      }),
      1,
      fromCallback(() => () => { stopped += 1; }),
    );
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(runtime);
    const runtimeInstance = set.resolve(runtime.definition);
    void runtimeInstance.run();

    const closing = set.close();
    await Promise.resolve();
    expect(stopped).toBe(0);
    release();
    await closing;
    expect(stopped).toBe(1);
  });

  it('disposes registered resources before stopping its actor', async () => {
    const order: string[] = [];
    let releaseCleanup!: () => void;
    const runtime = record(
      'scope',
      (context) => {
        context.own({ dispose: () => { order.push('subscription'); } });
        context.own({ dispose: () => { order.push('tool'); } });
        context.own(async () => {
          order.push('cleanup:start');
          await new Promise<void>((resolve) => { releaseCleanup = resolve; });
          order.push('cleanup:end');
        });
        return {};
      },
      1,
      fromCallback(() => () => { order.push('actor:stop'); }),
    );
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(runtime);
    set.resolve(runtime.definition);

    const closing = set.close();
    await Promise.resolve();
    expect(order).toEqual(['cleanup:start']);

    releaseCleanup();
    await closing;

    expect(order).toEqual(['cleanup:start', 'cleanup:end', 'tool', 'subscription', 'actor:stop']);
  });

  it('resolves only the current definition object for a runtime id', async () => {
    const old = record('identity', () => ({ generation: 1 }), 1);
    const current = record('identity', () => ({ generation: 2 }), 2);
    const forged = defineAgentRuntime({
      id: 'identity',
      logic: fromCallback(() => {}),
      createApi: () => ({ generation: 999 }),
    });
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(old);

    expect(set.resolve(old.definition).generation).toBe(1);
    expect(() => set.resolve(forged)).toThrow("Agent runtime 'identity' is unavailable");

    set.apply(current);

    expect(() => set.resolve(old.definition)).toThrow("Agent runtime 'identity' is unavailable");
    expect(() => set.resolve(forged)).toThrow("Agent runtime 'identity' is unavailable");
    expect(set.resolve(current.definition).generation).toBe(2);
    await set.close();
  });

  it('retires the old runtime while allowing a new definition generation', async () => {
    let firstStopped = 0;
    let secondStopped = 0;
    const first = record(
      'replace',
      undefined,
      1,
      fromCallback(() => () => { firstStopped += 1; }),
    );
    const second = record(
      'replace',
      undefined,
      2,
      fromCallback(() => () => { secondStopped += 1; }),
    );
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(first);
    set.resolve(first.definition);
    set.retireDefinition(first);
    await Promise.resolve();
    expect(set.inspect()).toContainEqual(expect.objectContaining({ generation: 1, status: 'retired' }));
    set.apply(second);
    set.resolve(second.definition);
    await set.close();
    expect(firstStopped).toBe(1);
    expect(secondStopped).toBe(1);
  });
});
