import { describe, expect, it } from 'vitest';
import { createAgentProjector } from '../../src/renderer/api/daemon/agentEventProjector';

// Live provenance for goal-continuation turns: the trigger user message is
// persisted server-side but never broadcast, so the projector synthesizes a
// hidden copy from the turn.started frame's origin (mirroring cron.fired).
describe('agentEventProjector goal continuation synthesis', () => {
  it('synthesizes a hidden user message from a goal_continuation turn.started', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'turn.started',
      {
        turnId: 2,
        origin: { kind: 'system_trigger', name: 'goal_continuation' },
        prompt: 'Continue working toward the active goal. …',
      },
      'session-1',
    );
    const created = events.filter((e) => e.type === 'messageCreated');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'messageCreated',
      message: {
        role: 'user',
        metadata: { origin: { kind: 'system_trigger', name: 'goal_continuation' } },
      },
    });
    // …and the turn activation still projects as usual.
    expect(events.some((e) => e.type === 'turnActiveChanged')).toBe(true);
  });

  it('derives the synthetic id from the turn so replays dedupe downstream', () => {
    const projector = createAgentProjector();
    const frame = {
      turnId: 7,
      origin: { kind: 'system_trigger', name: 'goal_continuation' },
    };
    const idOf = (events: { type: string }[]): string | undefined => {
      const e = events.find((ev) => ev.type === 'messageCreated') as
        | { type: 'messageCreated'; message: { id: string } }
        | undefined;
      return e?.message.id;
    };
    const first = projector.project('turn.started', frame, 'session-1');
    const second = projector.project('turn.started', frame, 'session-1');
    expect(idOf(first)).toBe('goal_cont_7');
    expect(idOf(second)).toBe('goal_cont_7');
  });

  it('does not synthesize for user-driven or other-trigger turns', () => {
    const projector = createAgentProjector();
    for (const origin of [
      { kind: 'user' },
      { kind: 'system_trigger', name: 'other_trigger' },
      { kind: 'cron_job', jobId: 'job-1' },
    ]) {
      const events = projector.project('turn.started', { turnId: 1, origin }, 'session-1');
      expect(events.filter((e) => e.type === 'messageCreated')).toHaveLength(0);
    }
  });
});

describe('agentEventProjector task notification synthesis', () => {
  it('synthesizes the notification message from a task.notified frame', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'task.notified',
      {
        notificationType: 'task.completed',
        title: 'Background process completed',
        body: '后台等待 2 秒 completed.',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: 'bash-9',
      },
      'session-1',
    );
    const created = events.filter((e) => e.type === 'messageCreated');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'messageCreated',
      message: {
        id: 'task_ntf_task:bash-9:completed',
        role: 'user',
        metadata: {
          origin: { kind: 'task', taskId: 'bash-9', status: 'completed', notificationId: 'task:bash-9:completed' },
        },
      },
    });
    // The reconstructed XML carries every field (entities escaped).
    const text =
      created[0]?.type === 'messageCreated' && created[0].message.content[0]?.type === 'text'
        ? created[0].message.content[0].text
        : '';
    expect(text).toContain('type="task.completed"');
    expect(text).toContain('Title: Background process completed');
    expect(text).toContain('后台等待 2 秒 completed.');
  });

  it('does not synthesize for user-driven or other-trigger turns', () => {
    const projector = createAgentProjector();
    for (const origin of [
      { kind: 'user' },
      { kind: 'system_trigger', name: 'other_trigger' },
      { kind: 'cron_job', jobId: 'job-1' },
    ]) {
      const events = projector.project('turn.started', { turnId: 1, origin }, 'session-1');
      expect(events.filter((e) => e.type === 'messageCreated')).toHaveLength(0);
    }
  });
});

describe('agentEventProjector turn retry phase', () => {
  const retryPhase = {
    kind: 'retrying',
    turnId: 1,
    step: 3,
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 3,
    delayMs: 1000,
    errorName: 'APIProviderRateLimitError',
    statusCode: 429,
  };

  it('projects the retrying phase into a turnRetry event', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'agent.status.updated',
      { agentId: 'main', phase: retryPhase },
      'session-1',
    );
    const retry = events.find((e) => e.type === 'turnRetry');
    expect(retry).toMatchObject({
      type: 'turnRetry',
      sessionId: 'session-1',
      retry: { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 1000, statusCode: 429 },
    });
    // …and the usage update still projects as usual.
    expect(events.some((e) => e.type === 'sessionUsageUpdated')).toBe(true);
  });

  it('emits one clear when a non-retrying phase follows, then stays quiet', () => {
    const projector = createAgentProjector();
    projector.project('agent.status.updated', { agentId: 'main', phase: retryPhase }, 'session-1');
    const first = projector.project(
      'agent.status.updated',
      { agentId: 'main', phase: { kind: 'streaming', turnId: 1, step: 3 } },
      'session-1',
    );
    expect(first.filter((e) => e.type === 'turnRetry')).toEqual([
      { type: 'turnRetry', sessionId: 'session-1', retry: undefined },
    ]);
    const second = projector.project(
      'agent.status.updated',
      { agentId: 'main', phase: { kind: 'streaming', turnId: 1, step: 3 } },
      'session-1',
    );
    expect(second.filter((e) => e.type === 'turnRetry')).toHaveLength(0);
  });

  it('ignores retrying phases of non-main agents', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'agent.status.updated',
      { agentId: 'agent-7', phase: retryPhase },
      'session-1',
    );
    expect(events.filter((e) => e.type === 'turnRetry')).toHaveLength(0);
  });
});

describe('agentEventProjector retry clear on step start', () => {
  it('clears the retry state when the next attempt starts streaming', () => {
    const projector = createAgentProjector();
    projector.project(
      'agent.status.updated',
      { agentId: 'main', phase: { kind: 'retrying', turnId: 1, step: 1, failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500 } },
      'session-1',
    );
    const events = projector.project(
      'turn.step.started',
      { agentId: 'main', turnId: 1, step: 2 },
      'session-1',
    );
    expect(events.filter((e) => e.type === 'turnRetry')).toEqual([
      { type: 'turnRetry', sessionId: 'session-1', retry: undefined },
    ]);
  });
});

describe('agentEventProjector retry clear robustness', () => {
  const retryPhase = {
    kind: 'retrying',
    turnId: 1,
    step: 1,
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 3,
    delayMs: 500,
  };

  it('keeps the retry state across phase-less status frames', () => {
    const projector = createAgentProjector();
    projector.project('agent.status.updated', { agentId: 'main', phase: retryPhase }, 'session-1');
    const events = projector.project(
      'agent.status.updated',
      { agentId: 'main', contextTokens: 1234 },
      'session-1',
    );
    expect(events.filter((e) => e.type === 'turnRetry')).toHaveLength(0);
  });

  it('clears on an explicit non-retrying phase', () => {
    const projector = createAgentProjector();
    projector.project('agent.status.updated', { agentId: 'main', phase: retryPhase }, 'session-1');
    const events = projector.project(
      'agent.status.updated',
      { agentId: 'main', phase: { kind: 'running', turnId: 1, step: 2 } },
      'session-1',
    );
    expect(events.filter((e) => e.type === 'turnRetry')).toEqual([
      { type: 'turnRetry', sessionId: 'session-1', retry: undefined },
    ]);
  });
});

describe('agentEventProjector same-frame ordering', () => {
  it('emits turnActiveChanged before the synthetic goal-continuation message', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'turn.started',
      {
        turnId: 5,
        origin: { kind: 'system_trigger', name: 'goal_continuation' },
        prompt: 'Continue working toward the active goal. …',
      },
      'session-1',
    );
    const types = events.map((e) => e.type);
    expect(types.indexOf('turnActiveChanged')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('turnActiveChanged')).toBeLessThan(types.indexOf('messageCreated'));
  });
});

describe('agentEventProjector retry from raw step frames', () => {
  it('emits turnRetry from turn.step.retrying with the attempt details', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'turn.step.retrying',
      { agentId: 'main', turnId: 1, step: 1, failedAttempt: 2, nextAttempt: 3, maxAttempts: 3, delayMs: 4000, statusCode: 429 },
      'session-1',
    );
    const retry = events.find((e) => e.type === 'turnRetry');
    expect(retry).toMatchObject({
      retry: { failedAttempt: 2, nextAttempt: 3, maxAttempts: 3, delayMs: 4000, statusCode: 429 },
    });
    // …and it is the arm's first event, so same-seq freshness keeps it.
    expect(events[0]?.type).toBe('turnRetry');
  });
});
