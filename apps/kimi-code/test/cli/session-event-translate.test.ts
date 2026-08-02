import { describe, expect, it } from 'vitest';

import { SessionEventTranslator } from '@moonshot-ai/kimi-code-sdk/rust';

describe('SessionEventTranslator', () => {
  it('maps the engine wire events onto the SDK Event union', () => {
    const t = new SessionEventTranslator('s1', 'main');

    const started = t.translate({ type: 'session.turn.started', session_id: 's1', turn_id: 3 });
    expect(started).toMatchObject({
      type: 'turn.started',
      sessionId: 's1',
      agentId: 'main',
      turnId: 3,
      origin: { kind: 'user' },
    });

    // Streaming deltas carry no turn id — the translator remembers it.
    const delta = t.translate({ type: 'llm.delta', part: { type: 'text', text: 'Hi' } });
    expect(delta).toMatchObject({ type: 'assistant.delta', turnId: 3, delta: 'Hi' });
    const think = t.translate({ type: 'llm.delta', part: { type: 'think', think: 'hmm' } });
    expect(think).toMatchObject({ type: 'thinking.delta', turnId: 3, delta: 'hmm' });

    const toolStart = t.translate({
      type: 'session.tool.started',
      tool_call_id: 'c1',
      tool_name: 'Read',
      arguments: { path: 'a.txt' },
    });
    expect(toolStart).toMatchObject({
      type: 'tool.call.started',
      toolCallId: 'c1',
      name: 'Read',
      args: { path: 'a.txt' },
    });
    const toolEnd = t.translate({
      type: 'session.tool.settled',
      tool_call_id: 'c1',
      tool_name: 'Read',
      content: 'file body',
      is_error: false,
    });
    expect(toolEnd).toMatchObject({
      type: 'tool.result',
      toolCallId: 'c1',
      output: 'file body',
      isError: false,
    });

    const ended = t.translate({
      type: 'session.turn.ended',
      turn_id: 3,
      stop_reason: 'Aborted',
      steps: 2,
    });
    expect(ended).toMatchObject({ type: 'turn.ended', turnId: 3, reason: 'cancelled' });
    // Natural end maps to completed.
    expect(
      t.translate({ type: 'session.turn.ended', turn_id: 4, stop_reason: 'EndTurn' }),
    ).toMatchObject({ reason: 'completed' });

    // session.goal.updated now maps to the SDK goal.updated event with the
    // snapshot fields remapped (snake_case → camelCase, PascalCase status →
    // snake_case value).
    const goal = t.translate({
      type: 'session.goal.updated',
      snapshot: {
        goal_id: 'g1',
        objective: 'ship it',
        status: 'BudgetLimited',
        turns_used: 4,
        tokens_used: 1234,
        wall_clock_ms: 5000,
        budget: {
          token_budget: 2000,
          turn_budget: null,
          wall_clock_budget_ms: null,
          remaining_tokens: 766,
          remaining_turns: null,
          remaining_wall_clock_ms: null,
          token_budget_reached: true,
          turn_budget_reached: false,
          wall_clock_budget_reached: false,
          over_budget: true,
        },
        created_at: 10,
        updated_at: 20,
        terminal_reason: 'A configured budget was reached',
      },
    });
    expect(goal).toMatchObject({
      type: 'goal.updated',
      snapshot: {
        goalId: 'g1',
        objective: 'ship it',
        status: 'budget_limited',
        turnsUsed: 4,
        tokensUsed: 1234,
        wallClockMs: 5000,
        budget: { tokenBudget: 2000, remainingTokens: 766, tokenBudgetReached: true, overBudget: true },
        terminalReason: 'A configured budget was reached',
      },
    });
    // A cleared goal (no snapshot) maps to a null snapshot.
    expect(t.translate({ type: 'session.goal.updated', status: 'none' })).toMatchObject({
      type: 'goal.updated',
      snapshot: null,
    });

    // Unknown / internal events render nothing.
    expect(t.translate({ type: 'llm.step.begin', model: 'm' })).toBeNull();
    expect(t.translate('not-an-object')).toBeNull();
  });

  it('swaps the stamped agent id for side-agent turns and returns the previous id', () => {
    const t = new SessionEventTranslator('s1', 'main');
    expect(t.translate({ type: 'session.turn.started', turn_id: 1 })).toMatchObject({
      agentId: 'main',
    });

    const previous = t.setAgentId('btw-s1');
    expect(previous).toBe('main');
    expect(t.translate({ type: 'session.turn.started', turn_id: 2 })).toMatchObject({
      agentId: 'btw-s1',
    });

    // Restore by passing the captured previous id back.
    t.setAgentId(previous);
    expect(t.translate({ type: 'session.turn.started', turn_id: 3 })).toMatchObject({
      agentId: 'main',
    });
  });
});
