import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';

describe('SessionInteractionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
  });
  afterEach(() => disposables.dispose());

  it('request blocks until respond resolves it', async () => {
    const svc = ix.get(ISessionInteractionService);
    const pending = svc.request<{ n: number }, string>({
      kind: 'question',
      payload: { n: 1 },
    });
    expect(svc.listPending()).toHaveLength(1);

    svc.respond(svc.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(svc.listPending()).toHaveLength(0);
  });

  it('uses the caller-provided id for correlation', async () => {
    const svc = ix.get(ISessionInteractionService);
    const pending = svc.request({ id: 'tool-1', kind: 'approval', payload: {} });
    expect(svc.listPending()[0]!.id).toBe('tool-1');
    svc.respond('tool-1', { decision: 'approved' });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('listPending filters by kind', () => {
    const svc = ix.get(ISessionInteractionService);
    void svc.request({ kind: 'approval', payload: {} });
    void svc.request({ kind: 'question', payload: {} });
    expect(svc.listPending('approval')).toHaveLength(1);
    expect(svc.listPending('question')).toHaveLength(1);
    expect(svc.listPending()).toHaveLength(2);
  });

  it('onDidChangePending fires on request and on respond', async () => {
    const svc = ix.get(ISessionInteractionService);
    let count = 0;
    disposables.add(svc.onDidChangePending(() => count++));
    const pending = svc.request({ kind: 'question', payload: {} });
    expect(count).toBe(1);
    svc.respond(svc.listPending()[0]!.id, 'x');
    await pending;
    expect(count).toBe(2);
  });

  it('onDidChangePending carries the pending ids snapshot', () => {
    const svc = ix.get(ISessionInteractionService);
    const snapshots: (readonly string[])[] = [];
    disposables.add(svc.onDidChangePending((e) => snapshots.push(e.pending)));
    void svc.request({ id: 'a', kind: 'approval', payload: {} });
    void svc.request({ id: 'b', kind: 'question', payload: {} });
    svc.respond('a', {});
    expect(snapshots).toEqual([['a'], ['a', 'b'], ['b']]);
  });

  it('respond to an unknown id is a no-op', () => {
    const svc = ix.get(ISessionInteractionService);
    expect(() => svc.respond('nope', 'x')).not.toThrow();
  });

  it('enqueue parks a request and returns it without blocking', () => {
    const svc = ix.get(ISessionInteractionService);
    const interaction = svc.enqueue({ id: 'e1', kind: 'approval', payload: { tool: 'bash' } });
    expect(interaction).toMatchObject({
      id: 'e1',
      kind: 'approval',
      payload: { tool: 'bash' },
    });
    expect(svc.listPending()).toHaveLength(1);
  });

  it('enqueue generates an id when none is provided', () => {
    const svc = ix.get(ISessionInteractionService);
    const interaction = svc.enqueue({ kind: 'question', payload: {} });
    expect(interaction.id).toMatch(/^interaction-/);
    expect(svc.listPending()[0]!.id).toBe(interaction.id);
  });

  it('onDidResolve fires with the id and response when responded to', () => {
    const svc = ix.get(ISessionInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    disposables.add(svc.onDidResolve((r) => seen.push(r)));

    svc.enqueue({ id: 'e1', kind: 'approval', payload: {} });
    svc.respond('e1', { decision: 'approved' });

    expect(seen).toEqual([{ id: 'e1', response: { decision: 'approved' } }]);
    expect(svc.listPending()).toHaveLength(0);
  });

  it('onDidResolve does not fire for an unknown id', () => {
    const svc = ix.get(ISessionInteractionService);
    let count = 0;
    disposables.add(svc.onDidResolve(() => count++));
    svc.respond('nope', 'x');
    expect(count).toBe(0);
  });

  it('cancelPendingForTurn clears pending interactions whose turn has ended (矛盾 c)', () => {
    const svc = ix.get(ISessionInteractionService);

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 3 } });
    svc.enqueue({ id: 'a2', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 7 } });
    expect(svc.listPending()).toHaveLength(2);

    svc.cancelPendingForTurn(3);

    expect(svc.listPending().map((i) => i.id)).toEqual(['a2']);
    expect(svc.isRecentlyResolved('a1')).toBe(true);
  });

  it('cancelPendingForTurn resolves cancelled interactions through onDidResolve', () => {
    const svc = ix.get(ISessionInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    disposables.add(svc.onDidResolve((r) => seen.push(r)));

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 5 } });
    svc.cancelPendingForTurn(5);

    expect(seen).toEqual([{ id: 'a1', response: { cancelled: true, reason: 'turn_ended' } }]);
    expect(svc.listPending()).toHaveLength(0);
  });

  it('cancelPendingForTurn is a no-op when no interaction matches', () => {
    const svc = ix.get(ISessionInteractionService);
    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 1 } });
    expect(() => svc.cancelPendingForTurn(99)).not.toThrow();
    expect(svc.listPending()).toHaveLength(1);
  });
});
