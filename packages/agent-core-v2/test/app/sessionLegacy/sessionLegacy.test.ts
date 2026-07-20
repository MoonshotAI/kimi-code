/**
 * Session legacy status scenarios.
 *
 * Resolves the edge adapter through DI and exercises its public status contract
 * with real scope-handle traversal. Agent/session domain collaborators are
 * narrow stubs so the scenario can model a persisted alias removed from the
 * current model catalog.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle, type ISessionScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { UNKNOWN_CAPABILITY } from '#/app/llmProtocol/capability';
import { ISessionLegacyService } from '#/app/sessionLegacy/sessionLegacy';
import { SessionLegacyService } from '#/app/sessionLegacy/sessionLegacyService';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

function accessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`Unexpected service request: ${String(id)}`);
    },
  };
}

describe('Session legacy status (best-effort runtime state)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('returns the persisted effort when the saved model alias no longer resolves', async () => {
    const profile = {
      _serviceBrand: undefined,
      data: () => ({
        cwd: '/workspace',
        modelAlias: 'removed-model',
        modelCapabilities: UNKNOWN_CAPABILITY,
        thinkingLevel: 'high',
        systemPrompt: '',
      }),
      getModel: () => 'removed-model',
      getModelCapabilities: () => UNKNOWN_CAPABILITY,
      getEffectiveThinkingLevel: () => 'high',
      resolveModelContext: () => {
        throw new Error('removed-model cannot be resolved');
      },
    } as unknown as IAgentProfileService;
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([
        [IAgentProfileService, profile],
        [IAgentContextSizeService, { get: () => ({ size: 25, measured: 20, estimated: 5 }) }],
        [IAgentPermissionModeService, { mode: 'manual' }],
        [IAgentPlanService, { status: () => Promise.resolve(null) }],
        [IAgentSwarmService, { isActive: false }],
        [
          IAgentActivityView,
          { state: () => ({ lifecycle: 'ready', background: [] }) },
        ],
      ]),
      dispose: () => {},
    };
    const agents = {
      // create is create-or-get for explicit ids: this session's main agent
      // already exists, so return it as-is (same as whenReady).
      create: () => Promise.resolve(agent),
      whenReady: () => Promise.resolve(agent),
      list: () => [agent],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-test',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
        [ISessionCronService, { _serviceBrand: undefined }],
      ]),
      dispose: () => {},
    };
    ix.stub(ISessionLifecycleService, {
      resume: () => Promise.resolve(session),
      get: () => session,
    });
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const status = await ix.get(ISessionLegacyService).status('session-test');

    expect(status).toMatchObject({
      busy: false,
      model: 'removed-model',
      thinking_level: 'high',
      max_context_tokens: 0,
    });
  });

  it('fans a permission_mode patch out through the session agent registry', async () => {
    const broadcastPermissionMode = vi.fn();
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([
        [IAgentProfileService, { _serviceBrand: undefined }],
        [IAgentLifecycleService, { broadcastPermissionMode }],
      ]),
      dispose: () => {},
    };
    const agents = {
      create: () => Promise.resolve(agent),
      whenReady: () => Promise.resolve(agent),
      list: () => [agent],
      broadcastPermissionMode,
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-test',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
        [
          ISessionMetadata,
          {
            read: () =>
              Promise.resolve({ id: 'session-test', createdAt: 0, updatedAt: 0, archived: false }),
          },
        ],
        [ISessionContext, { workspaceId: 'ws-test', cwd: '/workspace' }],
      ]),
      dispose: () => {},
    };
    ix.stub(ISessionLifecycleService, {
      resume: () => Promise.resolve(session),
      get: () => session,
    });
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    await ix.get(ISessionLegacyService).updateProfile('session-test', {
      agent_config: { permission_mode: 'yolo' },
    });

    expect(broadcastPermissionMode).toHaveBeenCalledWith('yolo');
  });
});
