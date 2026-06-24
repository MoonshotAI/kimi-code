import { describe, expect, it } from 'vitest';

import { ApprovalService } from '#/approval/approvalService';

describe('ApprovalService', () => {
  it('request parks until decide resolves it', async () => {
    const svc = new ApprovalService();
    const p = svc.request({ id: 'r1', toolName: 'bash' });
    expect(svc.listPending()).toEqual([{ id: 'r1', toolName: 'bash' }]);
    svc.decide('r1', 'allow');
    await expect(p).resolves.toBe('allow');
    expect(svc.listPending()).toEqual([]);
  });

  it('decide on unknown id is a no-op', () => {
    const svc = new ApprovalService();
    expect(() => svc.decide('missing', 'deny')).not.toThrow();
  });
});
