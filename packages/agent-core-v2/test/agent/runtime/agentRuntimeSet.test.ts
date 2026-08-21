import { assign, createMachine, fromCallback } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { AgentSpaceImpl } from '#/agent/agentContext/agentSpace';
import {
  defineAgentRuntime,
  type AgentRuntimeDefinition,
  type AgentRuntimeDefinitionRecord,
  type DurableAgentRuntimeParticipant,
} from '#/agent/runtime/agentRuntime';
import { AgentRuntimeSet } from '#/agent/runtime/agentRuntimeSet';
import type { DurableRuntimeParticipantHost } from '#/state/eventDispatcher';

const agent = { agentId: 'main', generation: 1, space: {} } as AgentContext;
const accessor = { get: vi.fn() } as unknown as ServicesAccessor;

function record<Facade>(
  id: string,
  createFacade: AgentRuntimeDefinitionRecord['definition']['createFacade'] = () => ({}) as Facade,
  generation = 1,
  logic: AgentRuntimeDefinition<any, any>['logic'] = fromCallback(() => {}),
  durable?: AgentRuntimeDefinition<any, any>['durable'],
): AgentRuntimeDefinitionRecord {
  return {
    capability: { id },
    definition: defineAgentRuntime({ id, logic, durable, createFacade }),
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
  it('materializes lazily and cleans up the actor when facade creation fails', () => {
    let stopped = 0;
    const runtime = record(
      'failing',
      () => { throw new Error('facade failed'); },
      1,
      fromCallback(() => () => { stopped += 1; }),
    );
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(runtime);

    expect(() => set.resolve(runtime.capability)).toThrow('facade failed');
    expect(stopped).toBe(1);
    expect(set.inspect()[0]).toMatchObject({ id: 'failing', status: 'failed', error: 'facade failed' });
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
    const facade = set.resolve<{ value: number }>(runtime.capability);

    space._kill();

    expect(facade.value).toBe(1);
    expect(set.resolve(runtime.capability)).toBe(facade);
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
    set.resolve(runtime.capability);
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

  it('disposes change listeners independently', async () => {
    let participant: { commit(state: number): void } | undefined;
    const runtime = record(
      'listeners',
      (_actor, context) => ({ onDidChange: context.onDidChange }),
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
    const facade = set.resolve<{ onDidChange(listener: (state: number) => void): IDisposable }>(
      runtime.capability,
    );
    const listener = vi.fn();
    const subscription = facade.onDidChange(listener);

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
      (_actor, context) => ({
        run: () => context.track(new Promise<void>((resolve) => { release = resolve; })),
      }),
      1,
      fromCallback(() => () => { stopped += 1; }),
    );
    const set = new AgentRuntimeSet(agent, accessor);
    set.apply(runtime);
    const facade = set.resolve<{ run(): Promise<void> }>(runtime.capability);
    void facade.run();

    const closing = set.close();
    await Promise.resolve();
    expect(stopped).toBe(0);
    release();
    await closing;
    expect(stopped).toBe(1);
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
    set.resolve(first.capability);
    set.retireDefinition(first);
    expect(set.inspect()).toContainEqual(expect.objectContaining({ generation: 1, status: 'retired' }));
    set.apply(second);
    set.resolve(second.capability);
    await set.close();
    expect(firstStopped).toBe(1);
    expect(secondStopped).toBe(1);
  });
});
