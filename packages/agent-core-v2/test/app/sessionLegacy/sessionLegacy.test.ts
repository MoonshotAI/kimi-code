import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle, type ISessionScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import {
  IAgentScopeContext,
  makeAgentScopeContext,
} from '#/agent/scopeContext/scopeContext';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { IAgentTowerService } from '#/features/tower/tower';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { ISessionLegacyService } from '#/app/sessionLegacy/sessionLegacy';
import { SessionLegacyService } from '#/app/sessionLegacy/sessionLegacyService';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';

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

function stubSessionChain(ix: TestInstantiationService, session: ISessionScopeHandle): void {
  const handler = {
    id: 'wd',
    kind: 'program',
    accessor: {
      get<T>(id: ServiceIdentifier<T>): T {
        if (id === ISessionLifecycleService) {
          return {
            resume: () => Promise.resolve(session),
            get: () => session,
          } as T;
        }
        return session.accessor.get(id);
      },
    },
    dispose: () => {},
  } as const;
  ix.stub(ISessionIndex, {
    get: (id: string) =>
      Promise.resolve(
        id === session.id
          ? {
              id: session.id,
              workspaceId: 'wd',
              cwd: '/workspace',
              createdAt: 1,
              updatedAt: 1,
              archived: false,
            }
          : undefined,
      ),
  });
  ix.stub(ISessionIndexMirror, {
    _serviceBrand: undefined,
    record: () => {},
    pending: () => [],
    evict: () => Promise.resolve(),
    drain: () => Promise.resolve(),
  });
  ix.stub(ISessionManager, {
    _serviceBrand: undefined,
    create: () => Promise.resolve(handler),
    resume: () => Promise.resolve(handler),
    get: () => handler,
    list: () => [handler],
    close: () => Promise.resolve(),
    archive: () => Promise.resolve(),
    restore: () => Promise.resolve(handler),
    delete: () => Promise.resolve(),
    fork: () => Promise.resolve(handler),
  } as unknown as ISessionManager);
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
        [IAgentLifecycleService, { main: () => Promise.resolve(agent) }],
        [
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }),
        ],
        [IAgentProfileService, profile],
        [ISessionTokenCountingService, { get: () => ({ size: 25, measured: 20, estimated: 5 }), statusSize: () => 25 }],
        [IAgentPermissionModeService, { mode: 'manual' }],
        [IAgentPlanService, { status: () => Promise.resolve(null) }],
        [IAgentSwarmService, { isActive: false }],
        [IAgentTowerService, { isActive: false }],
        [
          IAgentActivityView,
          { state: () => ({ lifecycle: 'ready', background: [] }) },
        ],
      ]),
      dispose: () => {},
    };
    const agents = {
      create: () => Promise.resolve(agentContextOf(agent)),
      handleOf: (agentId: string) => (agentId === 'main' ? agent : undefined),
      list: () => [agentContextOf(agent)],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-test',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
      ]),
      dispose: () => {},
    };
    stubSessionChain(ix, session);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const status = await ix.get(ISessionLegacyService).status('session-test');

    expect(status).toMatchObject({
      busy: false,
      model: 'removed-model',
      thinking_level: 'high',
    });
    expect(status.max_context_tokens).toBeUndefined();
  });

  it('reports an empty thinking level for a never-bound main agent', async () => {
    const profile = {
      _serviceBrand: undefined,
      data: () => ({
        cwd: '/workspace',
        modelAlias: undefined,
        modelCapabilities: UNKNOWN_CAPABILITY,
        thinkingLevel: 'off',
        systemPrompt: '',
      }),
      getModel: () => '',
      getModelCapabilities: () => UNKNOWN_CAPABILITY,
      getEffectiveThinkingLevel: () => 'off',
    } as unknown as IAgentProfileService;
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([
        [IAgentLifecycleService, { main: () => Promise.resolve(agent) }],
        [
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }),
        ],
        [IAgentProfileService, profile],
        [ISessionTokenCountingService, { get: () => ({ size: 0, measured: 0, estimated: 0 }), statusSize: () => 0 }],
        [IAgentPermissionModeService, { mode: 'manual' }],
        [IAgentPlanService, { status: () => Promise.resolve(null) }],
        [IAgentSwarmService, { isActive: false }],
        [IAgentTowerService, { isActive: false }],
        [IModelService, { getDefaultModel: () => undefined }],
        [
          IAgentActivityView,
          { state: () => ({ lifecycle: 'ready', background: [] }) },
        ],
      ]),
      dispose: () => {},
    };
    const agents = {
      create: () => Promise.resolve(agentContextOf(agent)),
      handleOf: (agentId: string) => (agentId === 'main' ? agent : undefined),
      list: () => [agentContextOf(agent)],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-unbound',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
      ]),
      dispose: () => {},
    };
    stubSessionChain(ix, session);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const status = await ix.get(ISessionLegacyService).status('session-unbound');

    expect(status).toMatchObject({
      busy: false,
      model: undefined,
      thinking_level: '',
    });
    expect(status.max_context_tokens).toBeUndefined();
  });

  it('falls back to the default model limit when no model is bound', async () => {
    const profile = {
      _serviceBrand: undefined,
      data: () => ({
        cwd: '/workspace',
        modelAlias: undefined,
        modelCapabilities: UNKNOWN_CAPABILITY,
        thinkingLevel: 'off',
        systemPrompt: '',
      }),
      getModel: () => '',
      getModelCapabilities: () => UNKNOWN_CAPABILITY,
      getEffectiveThinkingLevel: () => 'off',
    } as unknown as IAgentProfileService;
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([
        [IAgentLifecycleService, { main: () => Promise.resolve(agent) }],
        [
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }),
        ],
        [IAgentProfileService, profile],
        [ISessionTokenCountingService, { get: () => ({ size: 0, measured: 0, estimated: 0 }), statusSize: () => 0 }],
        [IAgentPermissionModeService, { mode: 'manual' }],
        [IAgentPlanService, { status: () => Promise.resolve(null) }],
        [IAgentSwarmService, { isActive: false }],
        [IAgentTowerService, { isActive: false }],
        [IModelService, { getDefaultModel: () => 'default-model' }],
        [
          IModelCatalog,
          {
            get: (id: string) => {
              if (id !== 'default-model') throw new Error(`unknown model ${id}`);
              return { capabilities: { max_context_tokens: 200_000 } };
            },
          },
        ],
        [
          IAgentActivityView,
          { state: () => ({ lifecycle: 'ready', background: [] }) },
        ],
      ]),
      dispose: () => {},
    };
    const agents = {
      create: () => Promise.resolve(agentContextOf(agent)),
      handleOf: (agentId: string) => (agentId === 'main' ? agent : undefined),
      list: () => [agentContextOf(agent)],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-draft',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
      ]),
      dispose: () => {},
    };
    stubSessionChain(ix, session);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const status = await ix.get(ISessionLegacyService).status('session-draft');

    expect(status).toMatchObject({
      model: undefined,
      max_context_tokens: 200_000,
    });
  });

  it('uses the input cap as the status denominator and clamps usage to 1', async () => {
    const profile = {
      _serviceBrand: undefined,
      data: () => ({
        cwd: '/workspace',
        modelAlias: 'gpt-5',
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 200_000,
          max_input_tokens: 100_000,
          dynamically_loaded_tools: false,
        },
        thinkingLevel: 'medium',
        systemPrompt: '',
      }),
      getModel: () => 'gpt-5',
      getModelCapabilities: () => ({
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 200_000,
        max_input_tokens: 100_000,
        dynamically_loaded_tools: false,
      }),
      getEffectiveThinkingLevel: () => 'medium',
    } as unknown as IAgentProfileService;
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([
        [IAgentLifecycleService, { main: () => Promise.resolve(agent) }],
        [
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }),
        ],
        [IAgentProfileService, profile],
        [ISessionTokenCountingService, { get: () => ({ size: 120_000, measured: 110_000, estimated: 10_000 }), statusSize: () => 120_000 }],
        [IAgentPermissionModeService, { mode: 'manual' }],
        [IAgentPlanService, { status: () => Promise.resolve(null) }],
        [IAgentSwarmService, { isActive: false }],
        [IAgentTowerService, { isActive: false }],
        [
          IAgentActivityView,
          { state: () => ({ lifecycle: 'ready', background: [] }) },
        ],
      ]),
      dispose: () => {},
    };
    const agents = {
      create: () => Promise.resolve(agentContextOf(agent)),
      handleOf: (agentId: string) => (agentId === 'main' ? agent : undefined),
      list: () => [agentContextOf(agent)],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-capped',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
      ]),
      dispose: () => {},
    };
    stubSessionChain(ix, session);
    ix.set(ISessionLegacyService, new SyncDescriptor(SessionLegacyService));

    const status = await ix.get(ISessionLegacyService).status('session-capped');

    expect(status).toMatchObject({
      max_context_tokens: 100_000,
      context_usage: 1,
    });
  });
});
