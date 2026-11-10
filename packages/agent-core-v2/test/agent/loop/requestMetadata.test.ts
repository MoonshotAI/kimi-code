import { afterEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import {
  agentRoleOf,
  RequestMetadataTracker,
  turnTriggerOf,
  userInputIdOf,
} from '#/agent/loop/requestMetadata';
import { TurnStepCompleted } from '#/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SessionRequestAttributionService } from '#/session/requestAttribution/requestAttributionService';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { IEventDispatcher } from '#/state/eventDispatcher';

import {
  recordingWireLog,
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
} from '../../wire/stubs';

describe('request metadata', () => {
  const disposables = new DisposableStore();

  afterEach(() => {
    disposables.clear();
  });

  it('classifies agent roles from id and metadata', () => {
    expect(agentRoleOf('main', undefined)).toBe('main');
    expect(agentRoleOf('child', meta({ labels: { btw: 'true' } }))).toBe('btw');
    expect(agentRoleOf('child', meta({ labels: { profileName: 'tower-worker' } }))).toBe('tower_worker');
    expect(agentRoleOf('child', meta({ labels: { swarmItem: '1' } }))).toBe('swarm_member');
    expect(agentRoleOf('child', meta({ type: 'sub', labels: { sessionInit: 'agents-md' } }))).toBe('subagent');
    expect(agentRoleOf('child', meta({ labels: { parentAgentId: 'main' } }))).toBe('subagent');
    expect(agentRoleOf('child', undefined)).toBe('other');
  });

  it('classifies turn triggers from the opening origin', () => {
    expect(turnTriggerOf({ kind: 'user' })).toBe('user');
    expect(turnTriggerOf(skill('user-slash'))).toBe('skill');
    expect(turnTriggerOf(skill('model-tool'))).toBe('other');
    expect(turnTriggerOf({ kind: 'plugin_command', activationId: 'a', pluginId: 'p', commandName: 'c', trigger: 'user-slash' })).toBe('plugin_command');
    expect(turnTriggerOf({ kind: 'system_trigger', name: 'subagent' })).toBe('subagent_task');
    expect(turnTriggerOf({ kind: 'system_trigger', name: 'goal_continuation' })).toBe('goal_continuation');
    expect(turnTriggerOf({ kind: 'retry' })).toBe('swarm_retry');
    expect(turnTriggerOf({ kind: 'cron_job', jobId: 'j', cron: '* * * * *', recurring: true, coalescedCount: 1, stale: false })).toBe('cron');
    expect(turnTriggerOf({ kind: 'cron_missed', count: 1 })).toBe('cron');
    expect(turnTriggerOf({ kind: 'task', taskId: 't', status: 'completed', notificationId: 'n' })).toBe('background_task');
    expect(turnTriggerOf({ kind: 'injection', variant: 'tower_inbox' })).toBe('tower_inbox');
    expect(turnTriggerOf({ kind: 'injection', variant: 'shell_command_backgrounded' })).toBe('shell_background');
    expect(turnTriggerOf({ kind: 'hook_result', event: 'Stop' })).toBe('other');
  });

  it('keeps a user input id only for input the user sent', () => {
    expect(userInputIdOf({ kind: 'user' }, 'msg_1')).toBe('msg_1');
    expect(userInputIdOf(skill('user-slash'), 'msg_2')).toBe('msg_2');
    expect(userInputIdOf({ kind: 'plugin_command', activationId: 'a', pluginId: 'p', commandName: 'c', trigger: 'user-slash' }, 'msg_3')).toBe('msg_3');
    expect(userInputIdOf(skill('model-tool'), 'msg_4')).toBeUndefined();
    expect(userInputIdOf({ kind: 'system_trigger', name: 'subagent' }, 'msg_5')).toBeUndefined();
    expect(userInputIdOf({ kind: 'user' }, '')).toBeUndefined();
  });

  it('takes parent attribution when a subagent task is dispatched and refreshes it on the next task', async () => {
    const attribution = new SessionRequestAttributionService();
    const main = createTracker('main', attribution, { type: 'main' });
    await prompt(main, 1, { kind: 'user' }, 'msg_parent_1');
    attribution.noteActiveRequest('main', 'trace-spawn');

    const childMeta: AgentMeta = {
      type: 'sub',
      labels: { parentAgentId: 'main', profileName: 'coder' },
    };
    const child = createTracker('child-1', attribution, childMeta);
    await prompt(child, 1, SUBAGENT_TASK, 'sub_prompt_1');
    expect(child.tracker.resolve({ type: 'turn', turnId: 1, step: 1 })).toEqual({
      agentRole: 'subagent',
      turnTrigger: 'subagent_task',
      stepReason: 'turn_start',
      userInputId: 'msg_parent_1',
      parentRequestId: 'trace-spawn',
    });

    await child.dispatcher.dispatch(
      new TurnStepCompleted({ agentId: 'child-1', turnId: 1, step: 1 }),
    );
    expect(child.tracker.resolve({ type: 'turn', turnId: 1, step: 2 }).stepReason).toBe(
      'tool_results',
    );
    await child.dispatcher.dispatch(
      new TurnEnded({ agentId: 'child-1', turnId: 1, reason: 'completed' }),
    );

    await prompt(main, 2, { kind: 'user' }, 'msg_parent_2');
    attribution.noteActiveRequest('main', 'trace-resume');

    const rebuilt = createTracker('child-1', attribution, childMeta);
    await prompt(rebuilt, 2, { kind: 'retry' });
    expect(rebuilt.tracker.resolve({ type: 'turn', turnId: 2, step: 1 })).toEqual({
      agentRole: 'subagent',
      turnTrigger: 'swarm_retry',
      stepReason: 'turn_start',
      userInputId: 'msg_parent_1',
      parentRequestId: 'trace-spawn',
    });

    await prompt(rebuilt, 3, SUBAGENT_TASK);
    expect(rebuilt.tracker.resolve({ type: 'turn', turnId: 3, step: 1 })).toEqual({
      agentRole: 'subagent',
      turnTrigger: 'subagent_task',
      stepReason: 'turn_start',
      userInputId: 'msg_parent_2',
      parentRequestId: 'trace-resume',
    });

    attribution.noteActiveRequest('child-1', 'trace-child');
    const grandchild = createTracker('child-2', attribution, {
      type: 'sub',
      labels: { parentAgentId: 'child-1' },
    });
    await prompt(grandchild, 1, SUBAGENT_TASK);
    expect(grandchild.tracker.resolve({ type: 'turn', turnId: 1, step: 1 })).toMatchObject({
      userInputId: 'msg_parent_2',
      parentRequestId: 'trace-child',
    });
  });

  it('does not adopt the parent request when a subagent task is only replayed', async () => {
    const attribution = new SessionRequestAttributionService();
    attribution.noteUserInput('main', 'msg_now');
    attribution.noteActiveRequest('main', 'trace-unrelated');
    const log = recordingWireLog([]);
    const restored = createTracker(
      'child-1',
      attribution,
      { type: 'sub', labels: { parentAgentId: 'main' } },
      log,
    );
    await restoreTestEventDispatcher(restored.dispatcher, log, 'wire/child-1', [
      new TurnPrompt({ agentId: 'child-1', turnId: 1, origin: SUBAGENT_TASK, input: [] }).serialize(),
      new TurnEnded({ agentId: 'child-1', turnId: 1, reason: 'completed' }).serialize(),
    ]);

    expect(restored.tracker.resolve({ type: 'operation', requestKind: 'full_compaction' })).toEqual({
      agentRole: 'subagent',
      turnTrigger: 'user',
      stepReason: 'compact',
      userInputId: undefined,
      parentRequestId: undefined,
    });
  });

  it('omits parentRequestId for btw agents and restores main userInputId from wire replay', async () => {
    const attribution = new SessionRequestAttributionService();
    attribution.noteActiveRequest('main', 'trace-main');
    const btw = createTracker('btw-1', attribution, {
      type: 'sub',
      forkedFrom: 'main',
      labels: { btw: 'true' },
    });
    await prompt(btw, 1, { kind: 'user' }, 'msg_btw');
    expect(btw.tracker.resolve({ type: 'turn', turnId: 1, step: 1 })).toEqual({
      agentRole: 'btw',
      turnTrigger: 'user',
      stepReason: 'turn_start',
      userInputId: 'msg_btw',
      parentRequestId: undefined,
    });

    const replayed = new SessionRequestAttributionService();
    const log = recordingWireLog([]);
    const restored = createTracker('main', replayed, { type: 'main' }, log);
    await restoreTestEventDispatcher(restored.dispatcher, log, 'wire/main', [
      new TurnPrompt({
        agentId: 'main',
        turnId: 1,
        origin: { kind: 'user' },
        promptId: 'msg_persisted',
        input: [],
      }).serialize(),
      new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }).serialize(),
    ]);
    expect(
      restored.tracker.resolve({ type: 'operation', requestKind: 'full_compaction' }),
    ).toEqual({
      agentRole: 'main',
      turnTrigger: 'user',
      stepReason: 'compact',
      userInputId: 'msg_persisted',
      parentRequestId: undefined,
    });
    expect(replayed.of('main')).toEqual({ userInputId: 'msg_persisted' });
  });

  interface TestTracker {
    readonly agentId: string;
    readonly tracker: RequestMetadataTracker;
    readonly dispatcher: IEventDispatcher;
  }

  function createTracker(
    agentId: string,
    attribution: SessionRequestAttributionService,
    agentMeta: AgentMeta,
    log = recordingWireLog([]),
  ): TestTracker {
    const ix = disposables.add(new TestInstantiationService());
    registerTestAgentWire(ix, `wire/${agentId}`, { log, agentId });
    const scopeContext = { ...ix.get(IAgentScopeContext), meta: agentMeta };
    const dispatcher = registerTestEventDispatcher(ix);
    const tracker = new RequestMetadataTracker(scopeContext, dispatcher, attribution);
    return { agentId, tracker, dispatcher };
  }

  async function prompt(
    target: TestTracker,
    turnId: number,
    origin: PromptOrigin,
    promptId?: string,
  ): Promise<void> {
    await target.dispatcher.dispatch(
      new TurnPrompt({ agentId: target.agentId, turnId, origin, promptId, input: [] }),
    );
  }
});

const SUBAGENT_TASK: PromptOrigin = { kind: 'system_trigger', name: 'subagent' };

function meta(patch: Partial<AgentMeta>): AgentMeta {
  return patch;
}

function skill(trigger: 'user-slash' | 'model-tool'): PromptOrigin {
  return { kind: 'skill_activation', activationId: 'a', skillName: 's', trigger };
}
