import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { ApprovalRequest } from '#/approval';
import { IApprovalService } from '#/approval';
import { ApprovalService } from '#/approval/approvalService';

const display: ToolInputDisplay = { kind: 'command', command: 'bash' };

function makeRequest(id: string): ApprovalRequest {
  return { id, toolName: 'bash', action: 'run', display };
}

describe('ApprovalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IApprovalService, new SyncDescriptor(ApprovalService));
  });
  afterEach(() => disposables.dispose());

  it('request parks until decide resolves it', async () => {
    const svc = ix.get(IApprovalService);
    const req = makeRequest('r1');
    const p = svc.request(req);
    expect(svc.listPending()).toEqual([req]);
    svc.decide('r1', { decision: 'approved' });
    await expect(p).resolves.toEqual({ decision: 'approved' });
    expect(svc.listPending()).toEqual([]);
  });

  it('decide on unknown id is a no-op', () => {
    const svc = ix.get(IApprovalService);
    expect(() => svc.decide('missing', { decision: 'rejected' })).not.toThrow();
  });
});
