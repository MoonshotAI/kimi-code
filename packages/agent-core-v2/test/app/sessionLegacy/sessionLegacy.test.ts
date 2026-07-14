/**
 * Session legacy status scenarios.
 *
 * Resolves the edge adapter through DI and exercises its public status contract
 * with real scope-handle traversal. Agent/session domain collaborators are
 * narrow stubs so the scenario can model a persisted alias removed from the
 * current model catalog.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionActivity } from '#/session/sessionActivity/sessionActivity';

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
      ]),
      dispose: () => {},
    };
    const agents = {
      whenReady: () => Promise.resolve(agent),
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'session-test',
      kind: LifecycleScope.Session,
      accessor: accessor([
        [IAgentLifecycleService, agents],
        [ISessionCronService, { _serviceBrand: undefined }],
        [ISessionActivity, { status: () => 'idle' }],
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
      status: 'idle',
      model: 'removed-model',
      thinking_level: 'high',
      max_context_tokens: 0,
    });
  });
});
