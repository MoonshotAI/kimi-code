import { describe, expect, it } from 'vitest';
import { createActor } from '#/xstate2';

import { isInteractionCancellation, type InteractionPendingChangedEvent } from '#/interaction/interaction';
import { createInteractionFacade, type InteractionFacade } from '#/interaction/facade';
import { createInteractionMachine, type InteractionEmitted } from '#/interaction/machine';

function createTestFacade(now?: () => number): InteractionFacade {
  const actor = createActor(createInteractionMachine());
  actor.start();
  return createInteractionFacade(actor, now === undefined ? undefined : { now });
}

describe('interaction facade', () => {
  it('enqueues pending records and rejects duplicate pending ids', () => {
    const facade = createTestFacade();
    const changes: InteractionPendingChangedEvent[] = [];
    facade.onDidChangePending((event) => changes.push(event));

    const first = facade.enqueue({ kind: 'approval', payload: { toolCallId: 'tc-1' }, tags: { agentId: 'a1', turnId: 1, toolCallId: 'tc-1' } });
    expect(first.id).toBe('a1:interaction-0');
    expect(facade.findAll({ resolved: false })).toHaveLength(1);
    expect(changes).toEqual([{ pending: ['a1:interaction-0'] }]);

    expect(() =>
      facade.enqueue({ id: first.id, kind: 'approval', payload: {} }),
    ).toThrow(`Interaction "${first.id}" is already pending`);

    facade.respond(first.id, { decision: 'approved' });
    const again = facade.enqueue({ id: first.id, kind: 'approval', payload: {} });
    expect(again.id).toBe(first.id);
    expect(facade.findAll({ resolved: false })).toHaveLength(1);
  });

  it('resolves records through respond and reports unknown or settled ids', () => {
    const actor = createActor(createInteractionMachine());
    actor.start();
    const emitted: InteractionEmitted[] = [];
    actor.on('interaction.resolved', (event) => emitted.push(event));
    const facade = createInteractionFacade(actor);

    const item = facade.enqueue({ kind: 'question', payload: { questions: [] } });
    expect(facade.respond(item.id, { answer: 1 })).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'interaction.resolved', id: item.id, response: { answer: 1 } });
    expect(facade.findAll({ resolved: true }).map((i) => i.id)).toEqual([item.id]);
    expect(facade.respond(item.id, { answer: 2 })).toBe(false);
    expect(facade.respond('missing', null)).toBe(false);
  });

  it('finds interactions by id, kind, resolved state and tag subsets', () => {
    const facade = createTestFacade();
    facade.enqueue({ id: 'i1', kind: 'approval', payload: {}, tags: { agentId: 'a1', turnId: 1, toolCallId: 'tc-1' } });
    facade.enqueue({ id: 'i2', kind: 'question', payload: {}, tags: { agentId: 'a1', turnId: 2 } });
    facade.enqueue({ id: 'i3', kind: 'approval', payload: {}, tags: { agentId: 'a2', turnId: 1 } });
    facade.respond('i3', { decision: 'approved' });

    expect(facade.findAll({ kind: 'approval', resolved: false }).map((i) => i.id)).toEqual(['i1']);
    expect(facade.findAll({ tags: { agentId: 'a1' } }).map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(facade.findAll({ tags: { agentId: 'a1', turnId: 2 } }).map((i) => i.id)).toEqual(['i2']);
    expect(facade.findOne({ tags: { toolCallId: 'tc-1' } })?.id).toBe('i1');
    expect(facade.findOne({ id: 'i3' })?.id).toBe('i3');
    expect(facade.findAll({ resolved: true }).map((i) => i.id)).toEqual(['i3']);
    expect(facade.findOne({ tags: { agentId: 'nobody' } })).toBeUndefined();
  });

  it('waits for responses, returns settled responses immediately and rejects unknown ids', async () => {
    const facade = createTestFacade();
    const pending = facade.enqueue({ kind: 'approval', payload: {} });
    const waited = facade.wait<string>(pending.id);
    facade.respond(pending.id, 'yes');
    await expect(waited).resolves.toBe('yes');
    await expect(facade.wait<string>(pending.id)).resolves.toBe('yes');
    await expect(facade.wait('missing')).rejects.toThrow('Interaction "missing" does not exist');
  });

  it('rejects waiters on timeout and keeps the interaction pending', async () => {
    const facade = createTestFacade();
    const pending = facade.enqueue({ kind: 'approval', payload: {} });
    await expect(facade.wait(pending.id, { timeoutMs: 20 })).rejects.toThrow(
      `Timed out waiting for interaction "${pending.id}"`,
    );
    expect(facade.findOne({ id: pending.id, resolved: false })).toBeDefined();
    const late = facade.wait<string>(pending.id);
    facade.respond(pending.id, 'late');
    await expect(late).resolves.toBe('late');
  });

  it('settles pending waiters with agent_closed on stop', async () => {
    const facade = createTestFacade();
    const pending = facade.enqueue({ kind: 'approval', payload: {} });
    const waited = facade.wait(pending.id);
    facade.stop();
    const response = await waited;
    expect(isInteractionCancellation(response)).toBe(true);
    expect(facade.findAll({ resolved: false })).toHaveLength(0);
  });

  it('tracks recently resolved ids within the ttl', () => {
    let at = 1_000;
    const facade = createTestFacade(() => at);
    const pending = facade.enqueue({ kind: 'approval', payload: {} });
    expect(facade.isRecentlyResolved(pending.id)).toBe(false);
    facade.respond(pending.id, 'ok');
    expect(facade.isRecentlyResolved(pending.id)).toBe(true);
    at += 61_000;
    expect(facade.isRecentlyResolved(pending.id)).toBe(false);
    expect(facade.isRecentlyResolved('missing')).toBe(false);
  });
});
