import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import { DenyAllPermissionPolicyService } from '#/agent/permissionPolicy/policies/deny-all';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionBtwService, SIDE_QUESTION_SYSTEM_REMINDER } from '#/session/btw/btw';
import { SessionBtwService } from '#/session/btw/btwService';

describe('SessionBtwService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let fork: ReturnType<typeof vi.fn>;
  let appendSystemReminder: ReturnType<typeof vi.fn>;
  let registerPolicy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    appendSystemReminder = vi.fn();
    registerPolicy = vi.fn();

    const child = {
      id: 'agent-btw-1',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentSystemReminderService) return { appendSystemReminder };
          if (id === IAgentPermissionPolicyService) return { registerPolicy };
          return undefined;
        },
      },
    };
    fork = vi.fn(async () => child);
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      fork,
    } as unknown as IAgentLifecycleService);
    ix.set(ISessionBtwService, new SyncDescriptor(SessionBtwService));
  });
  afterEach(() => disposables.dispose());

  it('forks main and configures a side-question child agent', async () => {
    const svc = ix.get(ISessionBtwService);
    const id = await svc.start();

    expect(id).toBe('agent-btw-1');
    expect(fork).toHaveBeenCalledWith('main');
    expect(appendSystemReminder).toHaveBeenCalledWith(SIDE_QUESTION_SYSTEM_REMINDER, {
      kind: 'system_trigger',
      name: 'btw',
    });
    expect(registerPolicy).toHaveBeenCalledTimes(1);
    expect(registerPolicy.mock.calls[0]![0]).toBeInstanceOf(DenyAllPermissionPolicyService);
  });
});
