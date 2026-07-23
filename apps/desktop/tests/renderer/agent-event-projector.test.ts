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
