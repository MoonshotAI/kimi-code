import { describe, expect, it } from 'vitest';
import type { AppMessage, SessionPlan } from '../../src/renderer/api/types';
import { messagesToTurns } from '@moonshot-ai/app-core/client';

function exitPlanMessages(output = 'Plan saved to: /tmp/fallback.md'): AppMessage[] {
  return [
    {
      id: 'assistant_1',
      sessionId: 'session_1',
      role: 'assistant',
      content: [{
        type: 'toolUse',
        toolCallId: 'call_plan',
        toolName: 'ExitPlanMode',
        input: {},
      }],
      createdAt: '2026-07-24T00:00:00.000Z',
    },
    {
      id: 'tool_1',
      sessionId: 'session_1',
      role: 'tool',
      content: [{
        type: 'toolResult',
        toolCallId: 'call_plan',
        output,
      }],
      createdAt: '2026-07-24T00:00:01.000Z',
    },
  ];
}

function plan(review?: SessionPlan['review']): SessionPlan {
  return {
    agentId: 'main',
    toolCallId: 'call_plan',
    turnId: 'turn_1',
    source: 'interaction',
    plan: '# Complete plan',
    path: '/tmp/persisted.md',
    options: [{ label: 'Approach A', description: 'Small change' }],
    ...(review ? { review } : {}),
  };
}

describe('ExitPlanMode turn conversion', () => {
  it('attaches the persisted plan and final review to the historical tool row', () => {
    const persisted = plan({
      state: 'approved',
      selectedOption: 'Approach A',
      feedback: 'Keep it focused',
    });

    const turns = messagesToTurns(
      exitPlanMessages(),
      [],
      undefined,
      false,
      {},
      { call_plan: persisted },
    );

    expect(turns[0]?.tools?.[0]).toMatchObject({
      id: 'call_plan',
      name: 'ExitPlanMode',
      status: 'ok',
      plan: persisted,
      planPath: '/tmp/persisted.md',
    });
  });

  it('keeps auto-mode plans valid when no review exists', () => {
    const persisted = plan();
    const turns = messagesToTurns(
      exitPlanMessages(),
      [],
      undefined,
      false,
      {},
      { call_plan: persisted },
    );

    expect(turns[0]?.tools?.[0]?.plan?.review).toBeUndefined();
    expect(turns[0]?.tools?.[0]?.plan?.plan).toBe('# Complete plan');
  });

  it('falls back to the legacy result path when plan history is unavailable', () => {
    const turns = messagesToTurns(exitPlanMessages(), [], undefined, false);

    expect(turns[0]?.tools?.[0]).toMatchObject({
      plan: undefined,
      planPath: '/tmp/fallback.md',
    });
  });
});
