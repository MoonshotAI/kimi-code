// Goal compaction-awareness (v1 engine): an auto compaction must PARK the goal
// (instead of letting the continuation driver keep tearing down turns — which
// cancelled the in-flight compaction over and over) and auto-resume it once the
// compaction completes. See arrrrny/kimi-code-sync#9.
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import {
  GOAL_COMPACTION_PAUSE_REASON,
  GoalMode,
  type GoalChange,
  type GoalSnapshot,
} from '../../../src/agent/goal';
import type { CompactionStrategy } from '../../../src/agent/compaction';
import type { AgentRecord } from '../../../src/agent/records';
import type { AgentReplayRecord } from '../../../src/rpc/resumed';
import { GOAL_CONTINUATION_ORIGIN, GOAL_CONTINUATION_PROMPT } from '../../../src/agent/turn';
import type { TelemetryProperties } from '../../../src/telemetry';

import { testAgent } from '../harness/agent';

interface TelemetryRecord {
  readonly event: string;
  readonly properties: TelemetryProperties;
}

function makeGoalMode() {
  const records: AgentRecord[] = [];
  const replay: AgentReplayRecord[] = [];
  const events: Array<{
    readonly type: string;
    readonly snapshot?: GoalSnapshot | null;
    readonly change?: GoalChange;
  }> = [];
  const telemetry: TelemetryRecord[] = [];
  const prompt = vi.fn();
  const agent = {
    records: {
      logRecord: (record: AgentRecord) => {
        records.push(record);
      },
    },
    emitEvent: (event: {
      readonly type: string;
      readonly snapshot?: GoalSnapshot | null;
      readonly change?: GoalChange;
    }) => {
      events.push(event);
    },
    telemetry: {
      track: (event: string, properties: TelemetryProperties) => {
        telemetry.push({ event, properties });
      },
    },
    context: {
      appendSystemReminder: () => {},
    },
    replayBuilder: {
      push: (record: AgentReplayRecord) => {
        replay.push(record);
      },
    },
    turn: {
      hasActiveTurn: false,
      prompt,
    },
    fullCompaction: {
      isCompacting: false,
    },
  } as unknown as Agent;

  return { goals: new GoalMode(agent), records, replay, events, telemetry, prompt, agent };
}

describe('GoalMode compaction coordination', () => {
  it('parks an active goal for compaction with the dedicated pause reason', async () => {
    const { goals, events } = makeGoalMode();
    await goals.createGoal({ objective: 'Ship feature X' });

    const snapshot = await goals.pauseForCompaction();

    expect(snapshot?.status).toBe('paused');
    expect(snapshot?.terminalReason).toBe(GOAL_COMPACTION_PAUSE_REASON);
    expect(goals.getGoal().goal?.status).toBe('paused');
    expect(events.at(-1)?.change).toMatchObject({
      kind: 'lifecycle',
      status: 'paused',
      reason: GOAL_COMPACTION_PAUSE_REASON,
      actor: 'runtime',
    });
  });

  it('does not park a goal that is already stopped', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'Ship feature X' });
    await goals.pauseGoal({ reason: 'Paused by the user' });

    const snapshot = await goals.pauseForCompaction();

    expect(snapshot).toBeNull();
    expect(goals.getGoal().goal?.terminalReason).toBe('Paused by the user');
  });

  it('resumes a parked goal after compaction and launches a continuation when idle', async () => {
    const { goals, prompt } = makeGoalMode();
    await goals.createGoal({ objective: 'Ship feature X' });
    await goals.pauseForCompaction();

    const snapshot = await goals.resumeAfterCompaction();

    expect(snapshot?.status).toBe('active');
    expect(snapshot?.terminalReason).toBeUndefined();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }],
      GOAL_CONTINUATION_ORIGIN,
    );
  });

  it('does not relaunch a continuation while the goal turn is still live', async () => {
    const { goals, prompt, agent } = makeGoalMode();
    await goals.createGoal({ objective: 'Ship feature X' });
    await goals.pauseForCompaction();
    (agent.turn as { hasActiveTurn: boolean }).hasActiveTurn = true;

    const snapshot = await goals.resumeAfterCompaction();

    expect(snapshot?.status).toBe('active');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not resume a goal parked for another reason', async () => {
    const { goals, prompt } = makeGoalMode();
    await goals.createGoal({ objective: 'Ship feature X' });
    await goals.pauseGoal({ reason: 'Paused by the user' });

    const snapshot = await goals.resumeAfterCompaction();

    expect(snapshot).toBeNull();
    expect(goals.getGoal().goal?.status).toBe('paused');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not churn a goal the user resumed during the compaction', async () => {
    const { goals, prompt } = makeGoalMode();
    await goals.createGoal({ objective: 'Ship feature X' });
    await goals.pauseForCompaction();
    await goals.resumeGoal();

    const snapshot = await goals.resumeAfterCompaction();

    expect(snapshot).toBeNull();
    expect(goals.getGoal().goal?.status).toBe('active');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not resume a cancelled goal', async () => {
    const { goals, prompt } = makeGoalMode();
    await goals.createGoal({ objective: 'Ship feature X' });
    await goals.pauseForCompaction();
    await goals.cancelGoal();

    const snapshot = await goals.resumeAfterCompaction();

    expect(snapshot).toBeNull();
    expect(goals.getGoal().goal).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not resume a replacement goal', async () => {
    const { goals, prompt } = makeGoalMode();
    await goals.createGoal({ objective: 'old task' });
    await goals.pauseForCompaction();
    await goals.createGoal({ objective: 'new task', replace: true });

    const snapshot = await goals.resumeAfterCompaction();

    expect(snapshot).toBeNull();
    expect(goals.getGoal().goal?.objective).toBe('new task');
    expect(goals.getGoal().goal?.status).toBe('active');
    expect(prompt).not.toHaveBeenCalled();
  });
});

/**
 * A strategy that allows exactly `times` auto compactions in total: each
 * `compaction.started` event spends one, so later steps in the same turn run
 * clean and the scripted responses line up deterministically.
 */
function compactExactly(times: number): {
  readonly strategy: CompactionStrategy;
  readonly spend: () => void;
} {
  let remaining = times;
  return {
    strategy: {
      shouldCompact: () => remaining > 0,
      shouldBlock: () => remaining > 0,
      checkAfterStep: false,
      maxCompactionPerTurn: times,
      maxOverflowCompactionAttempts: 3,
    },
    spend: () => {
      remaining = Math.max(0, remaining - 1);
    },
  };
}

describe('goal drive across an auto compaction', () => {
  it('parks the goal while compacting, resumes on completion, and completes the drive', async () => {
    const { strategy, spend } = compactExactly(2);
    const ctx = testAgent({ compactionStrategy: strategy });
    ctx.emitter.on('compaction.started', () => {
      spend();
    });
    ctx.configure({
      tools: ['GetGoal', 'UpdateGoal'],
      provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
      modelCapabilities: {
        image_in: true,
        video_in: true,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 256_000,
      },
    });

    await ctx.rpc.createGoal({ objective: 'work' });

    // Turn 1: auto compaction (summary), then the model's step.
    ctx.mockNextResponse({ type: 'text', text: 'First compaction summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'Working on it.' });
    // Turn 2: compaction again (one per turn by strategy), then the model completes.
    ctx.mockNextResponse({ type: 'text', text: 'Second compaction summary.' });
    ctx.mockNextResponse({
      type: 'function',
      id: 'c1',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'All done.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    await vi.waitFor(() => {
      expect(ctx.agent.goal.getGoal().goal).toBeNull();
    });

    const emitted = ctx.allEvents.filter((entry) => entry.type === '[rpc]');
    const compactionStarts = emitted.filter((entry) => entry.event === 'compaction.started');
    expect(compactionStarts).toHaveLength(2);
    for (const start of compactionStarts) {
      expect((start.args as { trigger?: string }).trigger).toBe('auto');
    }

    // Each auto compaction parked the goal with the compaction pause reason…
    const goalUpdates = emitted
      .filter((entry) => entry.event === 'goal.updated')
      .map((entry) => entry.args as { change?: GoalChange });
    expect(
      goalUpdates.filter(
        (update) =>
          update.change?.status === 'paused' && update.change.reason === GOAL_COMPACTION_PAUSE_REASON,
      ),
    ).toHaveLength(2);
    // …and each completion resumed it.
    expect(goalUpdates.filter((update) => update.change?.status === 'active')).toHaveLength(2);

    // The drive still finished the goal (two turns plus the final summary step).
    const turnStarts = emitted.filter((entry) => entry.event === 'turn.started');
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);
    expect(ctx.llmCalls.length).toBe(5);
    await ctx.expectResumeMatches();
  });

  it('does not park the goal for a manual compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      tools: ['GetGoal', 'UpdateGoal'],
      provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
      modelCapabilities: {
        image_in: true,
        video_in: true,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 256_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);

    await ctx.rpc.createGoal({ objective: 'work' });
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    expect(ctx.agent.goal.getGoal().goal?.status).toBe('active');
    await ctx.expectResumeMatches();
  });
});
