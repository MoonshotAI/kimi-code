/**
 * Web daemon projector contract for transcript isolation, task progress, and
 * client-visible error projection.
 */

import { describe, expect, it } from 'vitest';
import { classifyFrame, createAgentProjector, subagentProgressText } from '../src/api/daemon/agentEventProjector';

describe('subagentProgressText', () => {
  it('drops turn.step.started as noise', () => {
    expect(subagentProgressText('turn.step.started', {})).toBeNull();
  });

  it('summarizes a read tool call with its path', () => {
    const text = subagentProgressText('tool.use', { name: 'read', args: { path: 'src/foo.ts' } });
    expect(text).toContain('src/foo.ts');
    expect(text).not.toContain('"path"');
  });

  it('summarizes a bash tool call with its command', () => {
    const text = subagentProgressText('tool.call.started', { name: 'bash', args: { command: 'pnpm test' } });
    expect(text).toContain('pnpm test');
    expect(text).not.toContain('"command"');
  });

  it('drops tool.result lines as noise', () => {
    expect(subagentProgressText('tool.result', { name: 'read' })).toBeNull();
    expect(subagentProgressText('tool.result', { name: 'Read_0' })).toBeNull();
  });

  it('returns tool.progress update text', () => {
    expect(subagentProgressText('tool.progress', { update: { text: 'working…' } })).toBe('working…');
  });

  it('caps a long tool.progress text', () => {
    const long = 'x'.repeat(3000);
    const text = subagentProgressText('tool.progress', { update: { text: long } });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThan(long.length);
    expect(text!.endsWith('…')).toBe(true);
  });

  it('returns null for unknown event types', () => {
    expect(subagentProgressText('turn.delta', {})).toBeNull();
  });
});

describe('subagent streaming text', () => {
  it('forwards a subagent assistant.delta as a text-kind taskProgress', () => {
    const projector = createAgentProjector();
    const events = projector.project('assistant.delta', { agentId: 'sub-1', delta: 'Hello' }, 's1');
    expect(events).toContainEqual({
      type: 'taskProgress',
      sessionId: 's1',
      taskId: 'sub-1',
      outputChunk: 'Hello',
      stream: 'stdout',
      kind: 'text',
    });
  });

  it('drops an empty subagent assistant.delta', () => {
    const projector = createAgentProjector();
    const events = projector.project('assistant.delta', { agentId: 'sub-1', delta: '' }, 's1');
    expect(events).toEqual([]);
  });
});

describe('agent error projection', () => {
  it('drops a subagent error instead of surfacing it as a session warning', () => {
    const projector = createAgentProjector();

    expect(
      projector.project(
        'error',
        { agentId: 'sub-1', code: 'provider.rate_limit', message: 'Rate limited' },
        's1',
      ),
    ).toEqual([]);
  });

  it('keeps a main-agent error visible to the session', () => {
    const projector = createAgentProjector();

    expect(
      projector.project(
        'error',
        {
          agentId: 'main',
          code: 'provider.rate_limit',
          message: 'Rate limited',
          name: 'RateLimitError',
          details: { statusCode: 429, requestId: 'req_1' },
          retryable: true,
        },
        's1',
      ),
    ).toEqual([
      {
        type: 'unknown',
        raw: {
          _agentError: true,
          code: 'provider.rate_limit',
          message: 'Rate limited',
          name: 'RateLimitError',
          details: { statusCode: 429, requestId: 'req_1' },
          retryable: true,
        },
      },
    ]);
  });
});

describe('cron.fired', () => {
  it('synthesizes a user message so the cron notice renders live', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'cron.fired',
      {
        origin: {
          kind: 'cron_job',
          jobId: 'a3f9c2',
          cron: '*/5 * * * *',
          recurring: true,
          coalescedCount: 2,
          stale: false,
        },
        prompt: 'Check the deploy status',
      },
      's1',
    );
    const created = events.find((e) => e.type === 'messageCreated');
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      type: 'messageCreated',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Check the deploy status' }],
        metadata: { origin: { kind: 'cron_job', jobId: 'a3f9c2' } },
      },
    });
  });

  it('ignores cron.fired events missing a prompt or a cron_job origin', () => {
    const projector = createAgentProjector();
    expect(projector.project('cron.fired', { origin: { kind: 'cron_job' } }, 's1')).toEqual([]);
    expect(projector.project('cron.fired', { prompt: 'hi' }, 's1')).toEqual([]);
  });
});

describe('cron.fired prompt id isolation', () => {
  it('omits promptId so the synthesized notice does not clobber the abort cache', () => {
    const projector = createAgentProjector();
    projector.project(
      'prompt.submitted',
      { promptId: 'pr_user', userMessageId: 'u1', content: [{ type: 'text', text: 'hi' }] },
      's1',
    );
    const events = projector.project(
      'cron.fired',
      {
        origin: {
          kind: 'cron_job',
          jobId: 'j',
          cron: '* * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
        prompt: 'Check the deploy status',
      },
      's1',
    );
    const created = events.find((e) => e.type === 'messageCreated');
    expect(created).toBeDefined();
    expect((created as { message: { promptId?: string } }).message.promptId).toBeUndefined();
  });
});

describe('classifyFrame cron.fired', () => {
  it('routes both raw and event.-prefixed cron.fired to the agent projector', () => {
    const payload = { origin: { kind: 'cron_job' }, prompt: 'x' };
    expect(classifyFrame('cron.fired', payload)).toEqual({ route: 'agent', agentType: 'cron.fired' });
    expect(classifyFrame('event.cron.fired', payload)).toEqual({ route: 'agent', agentType: 'cron.fired' });
  });
});

// Session busy has a single source: the daemon's event.session.work_changed
// (mapped by toAppEvent). The raw turn stream must NOT project a second
// sessionWorkChanged per transition — when it did, every turn end fired
// turn-end consumers (completion notification, sound) twice.
describe('session status single-sourcing', () => {
  it('turn.started projects no sessionWorkChanged', () => {
    const projector = createAgentProjector();
    const events = projector.project('turn.started', { turnId: 1 }, 's1');
    expect(events.some((e) => e.type === 'sessionWorkChanged')).toBe(false);
  });

  it('turn.ended finalizes the message and usage but projects no sessionWorkChanged', () => {
    const projector = createAgentProjector();
    projector.project('turn.started', { turnId: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 's1');
    const events = projector.project(
      'turn.ended',
      { turnId: 1, reason: 'completed', durationMs: 123 },
      's1',
    );
    expect(events.some((e) => e.type === 'sessionWorkChanged')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'messageUpdated', status: 'completed', durationMs: 123 }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'sessionUsageUpdated' }));
  });

  it('seedInFlight returns only the seeded message — status comes from the snapshot', () => {
    const projector = createAgentProjector();
    const events = projector.seedInFlight('s1', {
      turnId: 1,
      assistantText: 'partial',
      thinkingText: '',
      runningTools: [],
    });
    expect(events.some((e) => e.type === 'sessionWorkChanged')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'messageCreated',
        message: expect.objectContaining({ role: 'assistant' }),
      }),
    );
  });
});

describe('main-turn liveness projection', () => {
  it('turn.started marks the main conversation active', () => {
    const projector = createAgentProjector();
    const events = projector.project('turn.started', { agentId: 'main', turnId: 1 }, 's1');
    expect(events).toContainEqual({ type: 'turnActiveChanged', sessionId: 's1', active: true });
  });

  it('turn.ended clears it and carries the reason', () => {
    const projector = createAgentProjector();
    projector.project('turn.started', { agentId: 'main', turnId: 1 }, 's1');
    const events = projector.project('turn.ended', { agentId: 'main', turnId: 1, reason: 'cancelled' }, 's1');
    expect(events).toContainEqual({
      type: 'turnActiveChanged',
      sessionId: 's1',
      active: false,
      reason: 'cancelled',
    });
  });

  it('subagent turn boundaries never touch main-conversation liveness', () => {
    const projector = createAgentProjector();
    const started = projector.project('turn.started', { agentId: 'agent-2', turnId: 1 }, 's1');
    const ended = projector.project('turn.ended', { agentId: 'agent-2', turnId: 1, reason: 'completed' }, 's1');
    expect([...started, ...ended].some((e) => e.type === 'turnActiveChanged')).toBe(false);
  });
});

describe('prompt-level lifecycle projection', () => {
  it('prompt.completed carries promptId and reason for the sending-flag cleanup', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'prompt.completed',
      { agentId: 'main', promptId: 'msg_1', reason: 'blocked', finishedAt: '2026-01-01T00:00:00Z' },
      's1',
    );
    expect(events).toContainEqual({
      type: 'promptCompleted',
      sessionId: 's1',
      promptId: 'msg_1',
      reason: 'blocked',
    });
  });

  it('prompt.aborted projects a promptAborted keyed by promptId', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'prompt.aborted',
      { agentId: 'main', promptId: 'msg_2', abortedAt: '2026-01-01T00:00:00Z' },
      's1',
    );
    expect(events).toContainEqual({ type: 'promptAborted', sessionId: 's1', promptId: 'msg_2' });
  });

  it('subagent-scoped prompt.aborted stays out of the main prompt channel', () => {
    const projector = createAgentProjector();
    const events = projector.project('prompt.aborted', { agentId: 'agent-2', promptId: 'msg_3' }, 's1');
    expect(events.some((e) => e.type === 'promptAborted')).toBe(false);
  });

  it('classifyFrame routes prompt.aborted to the agent projector', () => {
    expect(classifyFrame('prompt.aborted', { promptId: 'msg_1' })).toEqual({
      route: 'agent',
      agentType: 'prompt.aborted',
    });
  });
});

describe('step-boundary delta alignment', () => {
  it('resets stream offsets at step boundaries — a post-step delta ahead of local state signals a gap', () => {
    const projector = createAgentProjector();
    projector.project('turn.started', { turnId: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 's1');
    projector.project('assistant.delta', { turnId: 1, delta: 'step-one text' }, 's1', { offset: 0 });
    projector.project('turn.step.completed', { turnId: 1, step: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 2 }, 's1');

    const events = projector.project('assistant.delta', { turnId: 1, delta: 'tail' }, 's1', { offset: 12 });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'historyCompacted', reason: 'delta_gap' }),
    );
  });

  it('appends step-2 deltas to the fresh step message at step-relative offsets', () => {
    const projector = createAgentProjector();
    projector.project('turn.started', { turnId: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 's1');
    projector.project('assistant.delta', { turnId: 1, delta: 'step one' }, 's1', { offset: 0 });
    projector.project('turn.step.completed', { turnId: 1, step: 1 }, 's1');

    const step2 = projector.project('turn.step.started', { turnId: 1, step: 2 }, 's1');
    const created = step2.find((e) => e.type === 'messageCreated');
    const msgId = (created as { message: { id: string } } | undefined)?.message.id;
    expect(msgId).toBeDefined();

    // Offset restarts at 0 for the new step and appends to ITS message.
    const events = projector.project('assistant.delta', { turnId: 1, delta: 'step two' }, 's1', { offset: 0 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'assistantDelta',
        messageId: msgId,
        delta: { text: 'step two' },
      }),
    );
  });

  it('seeds only the current step and aligns live deltas against the seeded length', () => {
    const projector = createAgentProjector();
    const seeded = projector.seedInFlight('s1', {
      turnId: 7,
      promptId: 'pr_1',
      thinkingText: 'step two thinking',
      assistantText: 'step two partial',
      runningTools: [{ toolCallId: 'tc_1', name: 'bash', args: { command: 'ls' } }],
    });
    const created = seeded.find((e) => e.type === 'messageCreated');
    const message = (created as { message: { id: string; content: unknown[] } } | undefined)?.message;
    expect(message).toBeDefined();

    expect(message!.content).toEqual([
      { type: 'thinking', thinking: 'step two thinking' },
      { type: 'text', text: 'step two partial' },
      { type: 'toolUse', toolCallId: 'tc_1', toolName: 'bash', input: { command: 'ls' } },
    ]);

    const dup = projector.project('assistant.delta', { turnId: 7, delta: 'two part' }, 's1', { offset: 5 });
    expect(dup).toEqual([]);

    const cont = projector.project(
      'assistant.delta',
      { turnId: 7, delta: ' continues' },
      's1',
      { offset: 'step two partial'.length },
    );
    expect(cont).toContainEqual(
      expect.objectContaining({
        type: 'assistantDelta',
        messageId: message!.id,
        contentIndex: 3,
        delta: { text: ' continues' },
      }),
    );
  });
});

describe('turn.step.retrying bubble reuse', () => {
  it('refills the abandoned bubble instead of stacking a duplicate one', () => {
    const projector = createAgentProjector();
    const sid = 's1';
    projector.project('turn.started', { type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: sid }, sid);
    projector.project('turn.step.started', { type: 'turn.step.started', turnId: 1, step: 1, agentId: 'main', sessionId: sid }, sid);
    projector.project('assistant.delta', { type: 'assistant.delta', turnId: 1, delta: 'AB', agentId: 'main', sessionId: sid }, sid, { offset: 0 });
    projector.project('tool.call.started', { type: 'tool.call.started', turnId: 1, toolCallId: 'tc1', name: 'Bash', agentId: 'main', sessionId: sid }, sid);

    const retryEvents = projector.project('turn.step.retrying', { type: 'turn.step.retrying', turnId: 1, step: 1, failedAttempt: 1, nextAttempt: 2, maxAttempts: 10, delayMs: 100, agentId: 'main', sessionId: sid }, sid);
    expect(retryEvents).toContainEqual(expect.objectContaining({ type: 'messageUpdated' }));

    const restarted = projector.project('turn.step.started', { type: 'turn.step.started', turnId: 1, step: 1, agentId: 'main', sessionId: sid }, sid);
    // No new messageCreated for the retried step — the cleared bubble is reused.
    expect(restarted.filter((e) => e.type === 'messageCreated')).toEqual([]);

    const deltas = projector.project('assistant.delta', { type: 'assistant.delta', turnId: 1, delta: 'ABC', agentId: 'main', sessionId: sid }, sid, { offset: 0 });
    const toolEvents = projector.project('tool.call.started', { type: 'tool.call.started', turnId: 1, toolCallId: 'tc1', name: 'Bash', agentId: 'main', sessionId: sid }, sid);

    // The same bubble receives the retried stream: exactly one assistant
    // message id across the whole attempt→retry sequence.
    const messageIds = new Set(
      [...deltas, ...toolEvents]
        .map((e) => (e as { messageId?: string }).messageId)
        .filter((id): id is string => typeof id === 'string'),
    );
    expect(messageIds.size).toBe(1);
  });

  it('drops the reuse target when the turn ends before the retried step starts', () => {
    const projector = createAgentProjector();
    const sid = 's1';
    projector.project('turn.started', { type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: sid }, sid);
    projector.project('turn.step.started', { type: 'turn.step.started', turnId: 1, step: 1, agentId: 'main', sessionId: sid }, sid);
    projector.project('assistant.delta', { type: 'assistant.delta', turnId: 1, delta: 'AB', agentId: 'main', sessionId: sid }, sid, { offset: 0 });
    projector.project('turn.step.retrying', { type: 'turn.step.retrying', turnId: 1, step: 1, failedAttempt: 1, nextAttempt: 2, maxAttempts: 10, delayMs: 100, agentId: 'main', sessionId: sid }, sid);

    // The user aborts before the retried step.started ever arrives.
    projector.project('turn.ended', { type: 'turn.ended', turnId: 1, reason: 'interrupted', agentId: 'main', sessionId: sid }, sid);

    // The next prompt must open a fresh bubble — not refill the emptied one,
    // which would render the new response under the previous prompt.
    projector.project('turn.started', { type: 'turn.started', turnId: 2, origin: { kind: 'user' }, agentId: 'main', sessionId: sid }, sid);
    const started = projector.project('turn.step.started', { type: 'turn.step.started', turnId: 2, step: 1, agentId: 'main', sessionId: sid }, sid);
    expect(started.filter((e) => e.type === 'messageCreated')).toHaveLength(1);
  });

  it('drops the reuse target when the step is interrupted before the retry restarts', () => {
    const projector = createAgentProjector();
    const sid = 's1';
    projector.project('turn.started', { type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: sid }, sid);
    projector.project('turn.step.started', { type: 'turn.step.started', turnId: 1, step: 1, agentId: 'main', sessionId: sid }, sid);
    projector.project('assistant.delta', { type: 'assistant.delta', turnId: 1, delta: 'AB', agentId: 'main', sessionId: sid }, sid, { offset: 0 });
    projector.project('turn.step.retrying', { type: 'turn.step.retrying', turnId: 1, step: 1, failedAttempt: 1, nextAttempt: 2, maxAttempts: 10, delayMs: 100, agentId: 'main', sessionId: sid }, sid);

    projector.project('turn.step.interrupted', { type: 'turn.step.interrupted', turnId: 1, step: 1, agentId: 'main', sessionId: sid }, sid);

    // The next step.started creates a new bubble instead of reusing the
    // emptied one left by the interrupted retry attempt.
    const started = projector.project('turn.step.started', { type: 'turn.step.started', turnId: 1, step: 2, agentId: 'main', sessionId: sid }, sid);
    expect(started.filter((e) => e.type === 'messageCreated')).toHaveLength(1);
  });
});

describe('background subagent task registration', () => {
  it('folds task.started (kind agent) into the spawned row instead of adding a second row', () => {
    const projector = createAgentProjector();
    projector.project(
      'subagent.spawned',
      { subagentId: 'agent-1', description: 'Explore repo', runInBackground: true },
      's1',
    );

    const events = projector.project(
      'task.started',
      {
        info: {
          taskId: 'task-9',
          kind: 'agent',
          detached: true,
          agentId: 'agent-1',
          description: 'Explore repo',
          startedAt: 1767225600000,
        },
      },
      's1',
    );

    // A single patch of the WS-owned row — never a second (bash) task row.
    expect(events).toEqual([
      {
        type: 'taskCreated',
        sessionId: 's1',
        task: expect.objectContaining({
          id: 'agent-1',
          kind: 'subagent',
          description: 'Explore repo',
          runInBackground: true,
          backgroundTaskId: 'task-9',
        }),
      },
    ]);
  });

  it('keys a late registration by agent id so later progress frames stay on one row', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'task.started',
      {
        info: {
          taskId: 'task-9',
          kind: 'agent',
          detached: true,
          agentId: 'agent-1',
          description: 'Explore repo',
          startedAt: 1767225600000,
        },
      },
      's1',
    );

    expect(events).toEqual([
      {
        type: 'taskCreated',
        sessionId: 's1',
        task: expect.objectContaining({
          id: 'agent-1',
          kind: 'subagent',
          description: 'Explore repo',
          runInBackground: true,
          backgroundTaskId: 'task-9',
        }),
      },
    ]);

    // A later agent-scoped progress frame must not synthesize a second row.
    const progress = projector.project(
      'assistant.delta',
      { agentId: 'agent-1', delta: 'Hi' },
      's1',
    );
    expect(progress).toContainEqual(
      expect.objectContaining({ type: 'taskProgress', taskId: 'agent-1' }),
    );
    const created = progress.filter((e) => e.type === 'taskCreated');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      task: { id: 'agent-1', backgroundTaskId: 'task-9' },
    });
  });

  it('falls back to the task id when the registration carries no agent id', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'task.started',
      {
        info: {
          taskId: 'task-9',
          kind: 'agent',
          detached: true,
          description: 'Explore repo',
          startedAt: 1767225600000,
        },
      },
      's1',
    );

    expect(events).toEqual([
      {
        type: 'taskCreated',
        sessionId: 's1',
        task: expect.objectContaining({
          id: 'task-9',
          kind: 'subagent',
          description: 'Explore repo',
          runInBackground: true,
        }),
      },
    ]);
  });

  it('keeps projecting process tasks as bash rows', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'task.started',
      {
        info: {
          taskId: 'task-1',
          kind: 'process',
          description: 'npm test',
          command: 'npm test',
          startedAt: 1767225600000,
        },
      },
      's1',
    );

    expect(events).toEqual([
      {
        type: 'taskCreated',
        sessionId: 's1',
        task: expect.objectContaining({ id: 'task-1', kind: 'bash', command: 'npm test' }),
      },
    ]);
  });
});
