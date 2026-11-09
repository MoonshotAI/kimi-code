import { describe, expect, it } from 'vitest';

import type { PromptOrigin } from '#/agent/contextMemory/types';
import {
  agentRoleOf,
  requestMetadataHeader,
  turnTriggerOf,
  userInputIdOf,
} from '#/agent/loop/requestMetadata';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';

describe('request metadata', () => {
  it('classifies agent roles from id and metadata', () => {
    expect(agentRoleOf('main', undefined)).toBe('main');
    expect(agentRoleOf('child', meta({ labels: { btw: 'true' } }))).toBe('btw');
    expect(agentRoleOf('child', meta({ labels: { profileName: 'tower-worker' } }))).toBe('tower_worker');
    expect(agentRoleOf('child', meta({ labels: { swarmItem: '1' } }))).toBe('swarm_member');
    expect(agentRoleOf('child', meta({ labels: { sessionInit: 'agents-md' } }))).toBe('subagent');
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

  it('omits absent fields from the header', () => {
    expect(JSON.parse(requestMetadataHeader({ agent_role: 'main' })['X-Msh-Internal-Metadata']!)).toEqual({
      agent_role: 'main',
    });
  });
});

function meta(patch: Partial<AgentMeta>): AgentMeta {
  return patch;
}

function skill(trigger: 'user-slash' | 'model-tool'): PromptOrigin {
  return { kind: 'skill_activation', activationId: 'a', skillName: 's', trigger };
}
