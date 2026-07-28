import { describe, expect, it } from 'vitest';
import type { AppMessage } from '../../src/renderer/api/types';

import { messagesToTurns } from '../../src/renderer/composables/messagesToTurns';

describe('Agent transcript targets', () => {
  it('keeps the stable agent id carried by a Transcript tool frame', () => {
    const turns = messagesToTurns([
      message('call', 'assistant', [{
        type: 'toolUse',
        toolCallId: 'tool-1',
        toolName: 'Agent',
        input: { description: 'Inspect files' },
        agentRefs: [{ agentId: 'agent-30', role: 'child' }],
      }]),
    ], [], undefined, false);

    expect(turns[0]?.tools?.[0]?.agentId).toBe('agent-30');
  });

  it.each(['Agent', 'SubAgent', 'task'])(
    'recovers the stable agent id from a persisted %s result',
    (toolName) => {
      const turns = messagesToTurns([
        message('call', 'assistant', [{
          type: 'toolUse',
          toolCallId: 'tool-1',
          toolName,
          input: { description: 'Inspect files' },
        }]),
        message('result', 'tool', [{
          type: 'toolResult',
          toolCallId: 'tool-1',
          output: 'agent_id: agent-30\n\nDone.',
        }]),
      ], [], undefined, false);

      expect(turns[0]?.tools?.[0]?.agentId).toBe('agent-30');
    },
  );

  it.each(['SubAgent', 'task'])(
    'keeps the stable agent id carried by a normalized %s tool frame',
    (toolName) => {
      const turns = messagesToTurns([
        message('call', 'assistant', [{
          type: 'toolUse',
          toolCallId: 'tool-1',
          toolName,
          input: { description: 'Inspect files' },
          agentRefs: [{ agentId: 'agent-30', role: 'child' }],
        }]),
      ], [], undefined, false);

      expect(turns[0]?.tools?.[0]?.agentId).toBe('agent-30');
    },
  );
});

function message(
  id: string,
  role: AppMessage['role'],
  content: AppMessage['content'],
): AppMessage {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    createdAt: '2026-07-28T00:00:00.000Z',
  };
}
