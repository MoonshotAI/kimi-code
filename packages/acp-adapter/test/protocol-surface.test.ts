import { describe, expect, it } from 'vitest';

import {
  ACP_BUILTIN_SLASH_COMMANDS,
  CURRENT_VERSION,
  HideOutputMarker,
  isAcpBuiltinSlashCommand,
  isHideOutputMarker,
  KIMI_EXT_COMPACTION,
  KIMI_EXT_CONVERSATION_RESET,
  KIMI_EXT_STEP_INTERRUPTED,
  KIMI_EXT_SUBAGENT_EVENT,
  negotiateVersion,
  type RequestPermissionRequest,
  type SessionNotification,
  type SessionUpdate,
  type ToolCallUpdate,
} from '../src/protocol';

describe('acp protocol surface', () => {
  it('exposes pure protocol helpers from the protocol subpath source', () => {
    expect(CURRENT_VERSION.protocolVersion).toBe(1);
    expect(negotiateVersion(1)).toBe(CURRENT_VERSION);
    expect(ACP_BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toContain('help');
    expect(isAcpBuiltinSlashCommand('help')).toBe(true);
    expect(isHideOutputMarker(HideOutputMarker)).toBe(true);
    expect(KIMI_EXT_CONVERSATION_RESET).toBe('kimi/conversation_reset');
    expect(KIMI_EXT_STEP_INTERRUPTED).toBe('kimi/step_interrupted');
    expect(KIMI_EXT_COMPACTION).toBe('kimi/compaction');
    expect(KIMI_EXT_SUBAGENT_EVENT).toBe('kimi/subagent_event');
  });

  it('keeps ACP wire types available to consumers', () => {
    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    } satisfies SessionUpdate;

    const notification: SessionNotification = {
      sessionId: 'sess-1',
      update,
    };

    const toolCallUpdate: ToolCallUpdate = {
      toolCallId: 'tool-1',
      status: 'completed',
    };

    const permissionRequest: RequestPermissionRequest = {
      sessionId: 'sess-1',
      toolCall: toolCallUpdate,
      options: [{ optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' }],
    };

    expect(notification.update.sessionUpdate).toBe('agent_message_chunk');
    expect(permissionRequest.toolCall.toolCallId).toBe('tool-1');
  });
});
