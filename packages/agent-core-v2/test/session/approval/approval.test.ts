import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { type ApprovalRequest, ISessionApprovalService } from '#/session/approval/approval';
import { SessionApprovalService } from '#/session/approval/approvalService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';

import { stubInteractionManager, type InteractionManagerStub } from '../../features/interaction/stubs';

const display: ToolInputDisplay = { kind: 'command', command: 'bash' };

function makeRequest(id: string): ApprovalRequest {
  return { id, toolName: 'bash', action: 'run', display };
}

describe('SessionApprovalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let interactions: InteractionManagerStub;

  beforeEach(() => {
    disposables = new DisposableStore();
    interactions = stubInteractionManager();
    disposables.add(interactions.disposables);
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentLifecycleService, interactions.manager);
    ix.set(ISessionStateService, new SessionStateService());
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

  it('mints distinct interaction ids when the provider reuses a toolCallId within one step', async () => {
    const svc = ix.get(ISessionApprovalService);
    const interaction = interactions.serviceOf('main');
    const req = (): ApprovalRequest => ({
      toolCallId: 'Bash_0',
      toolName: 'bash',
      action: 'run',
      display,
    });

    const first = svc.request(req());
    const second = svc.request(req());

    const pending = interaction.listPending();
    expect(pending.map((i) => (i.payload as ApprovalRequest).toolCallId)).toEqual([
      'Bash_0',
      'Bash_0',
    ]);
    const ids = pending.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith('approval_'))).toBe(true);

    svc.decide(ids[0]!, { decision: 'approved' });
    svc.decide(ids[1]!, { decision: 'rejected' });
    await expect(first).resolves.toEqual({ decision: 'approved' });
    await expect(second).resolves.toEqual({ decision: 'rejected' });
  });

  it('a toolCallId repeated across steps still gets a fresh id after the first request resolved', async () => {
    const svc = ix.get(ISessionApprovalService);
    const interaction = interactions.serviceOf('main');
    const req = (): ApprovalRequest => ({
      toolCallId: 'Bash_0',
      toolName: 'bash',
      action: 'run',
      display,
    });

    const first = svc.request(req());
    const firstId = interaction.listPending()[0]!.id;
    svc.decide(firstId, { decision: 'approved' });
    await expect(first).resolves.toEqual({ decision: 'approved' });

    const second = svc.request(req());
    const secondId = interaction.listPending()[0]!.id;
    expect(secondId).not.toBe(firstId);
    svc.decide(secondId, { decision: 'approved' });
    await expect(second).resolves.toEqual({ decision: 'approved' });
  });

  it('listPending surfaces the minted interaction id so hosts can decide', async () => {
    const svc = ix.get(ISessionApprovalService);

    const parked = svc.request({ toolCallId: 'Bash_0', toolName: 'bash', action: 'run', display });
    const pending = svc.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toMatch(/^approval_/);
    expect(pending[0]!.toolCallId).toBe('Bash_0');

    svc.decide(pending[0]!.id!, { decision: 'approved' });
    await expect(parked).resolves.toEqual({ decision: 'approved' });
  });
});
