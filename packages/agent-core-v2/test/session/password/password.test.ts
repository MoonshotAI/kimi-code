import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { ISessionPasswordService, type PasswordRequest } from '#/session/password/password';
import { SessionPasswordService } from '#/session/password/passwordService';

function makeRequest(prompt: string, command?: string): PasswordRequest {
  return { prompt, command };
}

describe('SessionPasswordService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    ix.set(ISessionPasswordService, new SyncDescriptor(SessionPasswordService));
  });
  afterEach(() => disposables.dispose());

  it('request parks until resolve answers it', async () => {
    const svc = ix.get(ISessionPasswordService);
    const req: PasswordRequest = { id: 'p1', prompt: '[sudo] password for user: ', command: 'sudo ls' };
    const p = svc.request(req);
    expect(svc.listPending()).toEqual([req]);
    svc.resolve('p1', { cancelled: false, password: 'hunter2' });
    await expect(p).resolves.toEqual({ cancelled: false, password: 'hunter2' });
    expect(svc.listPending()).toEqual([]);
  });

  it('resolve with cancelled resolves the request without a password', async () => {
    const svc = ix.get(ISessionPasswordService);
    const p = svc.request({ id: 'p1', prompt: 'Password: ' });
    svc.resolve('p1', { cancelled: true });
    await expect(p).resolves.toEqual({ cancelled: true });
  });

  it('resolve on unknown id is a no-op', () => {
    const svc = ix.get(ISessionPasswordService);
    expect(() => svc.resolve('missing', { cancelled: true })).not.toThrow();
  });

  it('enqueue stamps a generated id and parks the request without blocking', () => {
    const svc = ix.get(ISessionPasswordService);
    const enqueued = svc.enqueue(makeRequest('Password: ', 'sudo whoami'));
    expect(enqueued.id).toMatch(/^password:/);
    expect(svc.listPending()).toEqual([{ prompt: 'Password: ', command: 'sudo whoami', id: enqueued.id }]);
    svc.resolve(enqueued.id, { cancelled: true });
    expect(svc.listPending()).toEqual([]);
  });

  it('generates distinct ids for concurrent requests', () => {
    const svc = ix.get(ISessionPasswordService);
    const first = svc.enqueue(makeRequest('one'));
    const second = svc.enqueue(makeRequest('two'));
    expect(first.id).not.toBe(second.id);
    expect(svc.listPending()).toHaveLength(2);
  });

  it('parks requests under the password interaction kind', () => {
    const svc = ix.get(ISessionPasswordService);
    svc.enqueue(makeRequest('Password: '));
    const interaction = ix.get(ISessionInteractionService);
    expect(interaction.listPending('password')).toHaveLength(1);
    expect(interaction.listPending('approval')).toHaveLength(0);
    expect(interaction.listPending('question')).toHaveLength(0);
  });
});
