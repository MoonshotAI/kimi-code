import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { type ApprovalRequest, ISessionApprovalService } from '#/session/approval/approval';
import { SessionApprovalService } from '#/session/approval/approvalService';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';

const display: ToolInputDisplay = { kind: 'command', command: 'bash' };

const noopEventBus: IEventBus = {
  _serviceBrand: undefined,
  publish: () => undefined,
  subscribe: () => ({ dispose: () => undefined }),
};

function makeRequest(id: string): ApprovalRequest {
  return { id, toolName: 'bash', action: 'run', display };
}

describe('SessionApprovalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IEventBus, noopEventBus);
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    ix.set(ISessionApprovalService, new SyncDescriptor(SessionApprovalService));
  });
  afterEach(() => disposables.dispose());

  it('request parks until decide resolves it', async () => {
    const svc = ix.get(ISessionApprovalService);
    const req = makeRequest('r1');
    const p = svc.request(req);
    expect(svc.listPending()).toEqual([req]);
    svc.decide('r1', { decision: 'approved' });
    await expect(p).resolves.toEqual({ decision: 'approved' });
    expect(svc.listPending()).toEqual([]);
  });

  it('decide on unknown id is a no-op', () => {
    const svc = ix.get(ISessionApprovalService);
    expect(() => svc.decide('missing', { decision: 'rejected' })).not.toThrow();
  });

  it('enqueue parks a request and returns it with its id without blocking', () => {
    const svc = ix.get(ISessionApprovalService);
    const enqueued = svc.enqueue(makeRequest('r1'));
    expect(enqueued).toEqual({ ...makeRequest('r1'), id: 'r1' });
    expect(svc.listPending()).toEqual([makeRequest('r1')]);
    svc.decide('r1', { decision: 'approved' });
    expect(svc.listPending()).toEqual([]);
  });

  it('handles multiple pending requests and resolves them independently', async () => {
    const svc = ix.get(ISessionApprovalService);
    const p1 = svc.request(makeRequest('r1'));
    const p2 = svc.request(makeRequest('r2'));
    expect(svc.listPending()).toHaveLength(2);

    svc.decide('r1', { decision: 'rejected' });
    await expect(p1).resolves.toEqual({ decision: 'rejected' });
    expect(svc.listPending()).toHaveLength(1);

    svc.decide('r2', { decision: 'approved' });
    await expect(p2).resolves.toEqual({ decision: 'approved' });
    expect(svc.listPending()).toEqual([]);
  });

  it('decide on an already resolved request is a no-op', async () => {
    const svc = ix.get(ISessionApprovalService);
    const p = svc.request(makeRequest('r1'));
    svc.decide('r1', { decision: 'approved' });
    await p;
    expect(() => svc.decide('r1', { decision: 'rejected' })).not.toThrow();
    expect(svc.listPending()).toEqual([]);
  });

  it('enqueue with a duplicate id still parks both requests', () => {
    const svc = ix.get(ISessionApprovalService);
    svc.enqueue(makeRequest('dup'));
    svc.enqueue(makeRequest('dup'));
    expect(svc.listPending()).toHaveLength(2);
    svc.decide('dup', { decision: 'approved' });
    expect(svc.listPending()).toHaveLength(1);
    svc.decide('dup', { decision: 'approved' });
    expect(svc.listPending()).toEqual([]);
  });
});
