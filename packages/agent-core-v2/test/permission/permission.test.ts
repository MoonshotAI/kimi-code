import { describe, expect, it } from 'vitest';

import { ApprovalService } from '#/approval/approvalService';
import {
  PermissionPolicyRegistry,
  PermissionService,
} from '#/permission/permissionService';

describe('PermissionPolicyRegistry', () => {
  it('returns the first non-undefined decision', () => {
    const reg = new PermissionPolicyRegistry();
    reg.register({ name: 'p1', evaluate: () => undefined });
    reg.register({ name: 'p2', evaluate: () => 'deny' });
    reg.register({ name: 'p3', evaluate: () => 'allow' });
    expect(reg.evaluate({ toolName: 'bash', args: {} })).toBe('deny');
  });

  it('defaults to allow when no policy matches', () => {
    const reg = new PermissionPolicyRegistry();
    expect(reg.evaluate({ toolName: 'bash', args: {} })).toBe('allow');
  });
});

describe('PermissionService', () => {
  function make(mode: 'yolo' | 'manual' | 'auto' = 'auto') {
    const reg = new PermissionPolicyRegistry();
    const approval = new ApprovalService();
    const svc = new PermissionService(
      reg,
      undefined as never,
      undefined as never,
      approval,
      undefined as never,
      mode,
    );
    return { svc, reg, approval };
  }

  it('yolo always allows', async () => {
    const { svc, reg } = make('yolo');
    reg.register({ name: 'deny-all', evaluate: () => 'deny' });
    expect(await svc.beforeToolCall({ toolName: 'bash', args: {} })).toBe('allow');
  });

  it('auto returns registry decision', async () => {
    const { svc, reg } = make('auto');
    reg.register({ name: 'deny-bash', evaluate: (ctx) => (ctx.toolName === 'bash' ? 'deny' : undefined) });
    expect(await svc.beforeToolCall({ toolName: 'bash', args: {} })).toBe('deny');
    expect(await svc.beforeToolCall({ toolName: 'read', args: {} })).toBe('allow');
  });

  it('auto routes ask through approval', async () => {
    const { svc, reg, approval } = make('auto');
    reg.register({ name: 'ask-all', evaluate: () => 'ask' });
    const p = svc.beforeToolCall({ toolName: 'bash', args: {} });
    approval.decide('bash', 'allow');
    await expect(p).resolves.toBe('allow');
  });

  it('manual always requests approval', async () => {
    const { svc, approval } = make('manual');
    const p = svc.beforeToolCall({ toolName: 'bash', args: {} });
    approval.decide('bash', 'deny');
    await expect(p).resolves.toBe('deny');
  });
});
