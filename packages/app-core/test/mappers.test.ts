
import { describe, expect, it } from 'vitest';

import {
  toAppAgentState,
  toAppEvent,
  toAppGoal,
  toAppInteractionEvent,
  toAppFsEntry,
  toAppWorkspace,
  toWireMessageContent,
} from '../src/api/daemon/mappers';
import type { WireInteraction } from '../src/api/daemon/wire';

describe('toAppFsEntry symlink directories', () => {
  it('maps the directory target marker without changing the symlink kind', () => {
    const entry = toAppFsEntry({
      path: 'link',
      name: 'link',
      kind: 'symlink',
      modified_at: '2026-01-01T00:00:00.000Z',
      is_directory: true,
    });
    expect(entry.kind).toBe('symlink');
    expect(entry.isDirectory).toBe(true);
  });
});

describe('toWireMessageContent media sources', () => {
  it('keeps a sessionMedia source in the session-scoped wire namespace', () => {
    expect(
      toWireMessageContent({ type: 'image', source: { kind: 'sessionMedia', fileId: 'f_sess' } }),
    ).toEqual({ type: 'image', source: { kind: 'session_media', file_id: 'f_sess' } });
  });

  it('preserves media names', () => {
    expect(
      toWireMessageContent({
        type: 'image',
        source: { kind: 'sessionMedia', fileId: 'f_sess' },
        name: 'photo.png',
      }),
    ).toEqual({
      type: 'image',
      source: { kind: 'session_media', file_id: 'f_sess' },
      name: 'photo.png',
    });
  });
});

describe('toAppEvent session', () => {
  function frame(change: 'created' | 'updated' | 'archived' | 'restored' | 'deleted') {
    return {
      type: 'session' as const,
      change,
      event_created_at: '2026-01-01T00:00:00.000Z',
      session: {
        id: 'sess_1',
        workspace_id: 'wd_1',
        cwd: '/work/app',
        title: 'Renamed',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        activity: 'background' as const,
        archived: false,
        last_prompt: 'hello',
      },
    };
  }

  it('maps archived and restored changes', () => {
    expect(toAppEvent(frame('archived'))).toEqual({
      type: 'sessionArchived',
      sessionId: 'sess_1',
      workspaceId: 'wd_1',
    });
    expect(toAppEvent(frame('restored'))).toEqual({ type: 'sessionRestored', sessionId: 'sess_1' });
  });

  it('maps deleted changes', () => {
    expect(toAppEvent(frame('deleted'))).toEqual({ type: 'sessionDeleted', sessionId: 'sess_1' });
  });

  it('maps the full session on updates', () => {
    expect(toAppEvent(frame('updated'))).toMatchObject({
      type: 'sessionWorkChanged',
      sessionId: 'sess_1',
      busy: true,
      mainTurnActive: false,
      session: { title: 'Renamed', lastPrompt: 'hello', cwd: '/work/app' },
    });
  });

  it('keeps the session device and maps device status events', () => {
    expect(toAppEvent({ ...frame('updated'), session: { ...frame('updated').session, device_id: 'dev' } }))
      .toMatchObject({ session: { deviceId: 'dev' } });
    expect(toAppEvent({
      type: 'event.device.changed',
      event_created_at: '2026-01-01T00:00:00.000Z',
      devices: [{ id: 'dev', connection: 'ssh', host: 'dev@example.test', status: 'ready' }],
    })).toEqual({
      type: 'devicesChanged',
      devices: [{ id: 'dev', connection: 'ssh', host: 'dev@example.test', status: 'ready' }],
    });
  });

  it('maps account devices with their remote identity and conflicts', () => {
    expect(toAppEvent({
      type: 'event.device.changed',
      event_created_at: '2026-01-01T00:00:00.000Z',
      devices: [{
        id: 'rc-mac',
        connection: 'account',
        status: 'disconnected',
        connect_error: 'device "rc-mac" is the same computer as device "devbox"',
        connect_failure: 'duplicate',
        device_id: 'rc-mac',
        product_name: 'kimi-code-desktop',
        platform: 'darwin',
        alias: 'Work Mac',
        duplicate_of: 'devbox',
      }],
    })).toEqual({
      type: 'devicesChanged',
      devices: [{
        id: 'rc-mac',
        connection: 'account',
        status: 'disconnected',
        connectError: 'device "rc-mac" is the same computer as device "devbox"',
        connectFailure: 'duplicate',
        deviceId: 'rc-mac',
        productName: 'kimi-code-desktop',
        platform: 'darwin',
        alias: 'Work Mac',
        duplicateOf: 'devbox',
      }],
    });
  });

  it('maps how a device was installed and the progress of its remote upgrade', () => {
    expect(toAppEvent({
      type: 'event.device.changed',
      event_created_at: '2026-01-01T00:00:00.000Z',
      devices: [{ id: 'rc-box', connection: 'account', status: 'connecting', install: 'cli', remote_upgrade: true, upgrade_status: 'restarting' }],
    })).toEqual({
      type: 'devicesChanged',
      devices: [{ id: 'rc-box', connection: 'account', status: 'connecting', install: 'cli', remoteUpgrade: true, upgradeStatus: 'restarting' }],
    });
  });
});

describe('toAppInteractionEvent', () => {
  const approval: WireInteraction = {
    type: 'interaction',
    session_id: 's1',
    agent_id: 'agent-2',
    event_created_at: '2026-01-01T00:00:00.000Z',
    interaction_id: 'a1',
    kind: 'approval',
    status: 'pending',
    tool_call_id: 'tc-1',
    request: {
      tool_name: 'Bash',
      action: 'run',
      tool_input_display: { kind: 'command' },
      expires_at: '2026-01-02T00:00:00.000Z',
    },
  };

  it('maps a pending approval with its agent', () => {
    expect(toAppInteractionEvent(approval)).toEqual({
      type: 'approvalRequested',
      sessionId: 's1',
      approval: {
        approvalId: 'a1',
        sessionId: 's1',
        agentId: 'agent-2',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        action: 'run',
        display: { kind: 'command' },
      },
    });
  });

  it('falls back to the interaction id when an approval has no tool call id', () => {
    const event = toAppInteractionEvent({ ...approval, tool_call_id: undefined });
    expect(event.type === 'approvalRequested' && event.approval.toolCallId).toBe('a1');
  });

  it('maps a pending question', () => {
    const event = toAppInteractionEvent(
      ({
        type: 'interaction',
        session_id: 's1',
        agent_id: 'main',
        event_created_at: '2026-01-01T00:00:00.000Z',
        interaction_id: 'q1',
        kind: 'question',
        status: 'pending',
        request: { questions: [{ id: 'q_0', question: 'Pick', options: [{ id: 'o1', label: 'A' }] }] },
      } satisfies WireInteraction),
    );
    expect(event).toMatchObject({
      type: 'questionRequested',
      question: { questionId: 'q1', agentId: 'main', questions: [{ id: 'q_0', options: [{ id: 'o1', label: 'A' }] }] },
    });
  });

  it('maps an ended approval with its outcome and response', () => {
    expect(
      toAppInteractionEvent(
        {
          ...approval,
          status: 'ended',
          outcome: 'rejected',
          response: { decision: 'rejected', feedback: 'no', selected_label: 'Revise' },
        },
      ),
    ).toEqual({
      type: 'interactionEnded',
      sessionId: 's1',
      interactionId: 'a1',
      kind: 'approval',
      outcome: 'rejected',
      feedback: 'no',
      selectedLabel: 'Revise',
    });
  });
});

describe('toAppWorkspace', () => {
  it('preserves the registered kind and additional directories from the wire contract', () => {
    expect(toAppWorkspace({
      id: 'wm_1',
      root: '/a',
      name: 'A',
      kind: 'implicit',
      additional_dirs: ['/b', '/c'],
      session_count: 2,
    })).toEqual({
      id: 'wm_1',
      root: '/a',
      name: 'A',
      kind: 'implicit',
      additionalDirs: ['/b', '/c'],
      lastOpenedAt: undefined,
      sessionCount: 2,
    });
  });
});

describe('agent feed frames', () => {
  it('maps the agent frame mode switches', () => {
    expect(
      toAppAgentState({
        type: 'agent',
        session_id: 's1',
        agent_id: 'main',
        event_created_at: '2026-01-01T00:00:00.000Z',
        status: 'running',
        model: 'k2',
        permission_mode: 'auto',
        plan_mode: true,
        swarm_mode: false,
        tower_mode: false,
      }),
    ).toEqual({
      status: 'running',
      model: 'k2',
      thinking: undefined,
      permissionMode: 'auto',
      planMode: true,
      swarmMode: false,
      towerMode: false,
    });
  });

  it('keeps the compacting flag of the agent frame beside its status', () => {
    expect(
      toAppAgentState({
        type: 'agent',
        session_id: 's1',
        agent_id: 'main',
        event_created_at: '2026-01-01T00:00:00.000Z',
        status: 'running',
        compacting: true,
        plan_mode: false,
        swarm_mode: false,
        tower_mode: false,
      }),
    ).toMatchObject({ status: 'running', compacting: true });
  });

  it('treats a goal frame without a goal as no goal', () => {
    expect(toAppGoal(undefined)).toBeNull();
  });
});
