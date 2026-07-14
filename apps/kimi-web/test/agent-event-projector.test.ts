/**
 * Scenario: raw agent events become browser-visible transcript events.
 * Responsibilities: isolate agents, preserve tool display, stream progress, and surface errors.
 * Wiring: real agent event projector; no collaborators are stubbed.
 * Run: pnpm --filter @moonshot-ai/kimi-web test -- agent-event-projector.test.ts
 */

import { describe, expect, it } from 'vitest';
import { classifyFrame, createAgentProjector, subagentProgressText } from '../src/api/daemon/agentEventProjector';

function createActiveProjector(sessionId = 's1') {
  const projector = createAgentProjector();
  projector.activate(sessionId);
  return projector;
}

describe('main-agent tool display projection (live transcript)', () => {
  it('includes the plan display when tool.call.started updates the assistant message', () => {
    const projector = createActiveProjector('session-1');
    projector.project('turn.started', { turnId: 1 }, 'session-1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 'session-1');

    const events = projector.project(
      'tool.call.started',
      {
        turnId: 1,
        toolCallId: 'plan-call',
        name: 'ExitPlanMode',
        args: {},
        display: {
          kind: 'plan_review',
          plan: '## Live plan\n\nVerify the real event path.',
          path: '/workspace/live-plan.md',
        },
      },
      'session-1',
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'messageUpdated',
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'toolUse',
            toolCallId: 'plan-call',
            toolInputDisplay: {
              kind: 'plan_review',
              plan: '## Live plan\n\nVerify the real event path.',
              path: '/workspace/live-plan.md',
            },
          }),
        ]),
      }),
    );
  });

  it('includes the plan display when a refresh seeds an in-flight tool', () => {
    const projector = createActiveProjector();

    const events = projector.seedInFlight('session-1', {
      turnId: 1,
      assistantText: '',
      thinkingText: '',
      runningTools: [
        {
          toolCallId: 'plan-call',
          name: 'ExitPlanMode',
          args: {},
          display: {
            kind: 'plan_review',
            plan: '## Refresh-safe live plan',
          },
        },
      ],
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'messageCreated',
        message: expect.objectContaining({
          content: [
            expect.objectContaining({
              type: 'toolUse',
              toolCallId: 'plan-call',
              toolInputDisplay: {
                kind: 'plan_review',
                plan: '## Refresh-safe live plan',
              },
            }),
          ],
        }),
      }),
    );
  });
});

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
    const projector = createActiveProjector();
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
    const projector = createActiveProjector();
    const events = projector.project('assistant.delta', { agentId: 'sub-1', delta: '' }, 's1');
    expect(events).toEqual([]);
  });
});

describe('agent error projection', () => {
  it('drops a subagent error instead of surfacing it as a session warning', () => {
    const projector = createActiveProjector();

    expect(
      projector.project(
        'error',
        { agentId: 'sub-1', code: 'provider.rate_limit', message: 'Rate limited' },
        's1',
      ),
    ).toEqual([]);
  });

  it('keeps a main-agent error visible to the session', () => {
    const projector = createActiveProjector();

    expect(
      projector.project(
        'error',
        { agentId: 'main', code: 'provider.rate_limit', message: 'Rate limited' },
        's1',
      ),
    ).toEqual([
      {
        type: 'unknown',
        raw: {
          _agentError: true,
          code: 'provider.rate_limit',
          message: 'Rate limited',
        },
      },
    ]);
  });
});

describe('cron.fired', () => {
  it('synthesizes a user message so the cron notice renders live', () => {
    const projector = createActiveProjector();
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
    const projector = createActiveProjector();
    expect(projector.project('cron.fired', { origin: { kind: 'cron_job' } }, 's1')).toEqual([]);
    expect(projector.project('cron.fired', { prompt: 'hi' }, 's1')).toEqual([]);
  });
});

describe('cron.fired prompt id isolation', () => {
  it('omits promptId so the synthesized notice does not clobber the abort cache', () => {
    const projector = createActiveProjector();
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

// Session status has a single source: the daemon's event.session.status_changed
// (mapped by toAppEvent). The raw turn stream must NOT project a second
// sessionStatusChanged per transition — when it did, every turn end fired
// turn-end consumers (completion notification, sound) twice.
describe('session status single-sourcing', () => {
  it('turn.started projects no sessionStatusChanged', () => {
    const projector = createActiveProjector();
    const events = projector.project('turn.started', { turnId: 1 }, 's1');
    expect(events.some((e) => e.type === 'sessionStatusChanged')).toBe(false);
  });

  it('turn.ended finalizes the message and usage but projects no sessionStatusChanged', () => {
    const projector = createActiveProjector();
    projector.project('turn.started', { turnId: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 's1');
    const events = projector.project(
      'turn.ended',
      { turnId: 1, reason: 'completed', durationMs: 123 },
      's1',
    );
    expect(events.some((e) => e.type === 'sessionStatusChanged')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'messageUpdated', status: 'completed', durationMs: 123 }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'sessionUsageUpdated' }));
  });

  it('seedInFlight returns only the seeded message — status comes from the snapshot', () => {
    const projector = createActiveProjector();
    const events = projector.seedInFlight('s1', {
      turnId: 1,
      assistantText: 'partial',
      thinkingText: '',
      runningTools: [],
    });
    expect(events.some((e) => e.type === 'sessionStatusChanged')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'messageCreated',
        message: expect.objectContaining({ role: 'assistant' }),
      }),
    );
  });
});

describe('step-boundary delta alignment', () => {
  it('resets stream offsets at step boundaries — a post-step delta ahead of local state signals a gap', () => {
    const projector = createActiveProjector();
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
    const projector = createActiveProjector();
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
      {
        type: 'toolUse',
        toolCallId: 'tc_1',
        toolName: 'bash',
        input: { command: 'ls' },
        turnId: 7,
        toolInputDisplay: undefined,
        outputLines: undefined,
      },
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

describe('projector session ownership', () => {
  it('drops queued frames after release until the session is activated again', () => {
    const projector = createActiveProjector();
    const submitted = {
      promptId: 'pr_1',
      userMessageId: 'msg_1',
      content: [{ type: 'text', text: 'hello' }],
    };

    projector.release('s1');
    expect(projector.project('prompt.submitted', submitted, 's1')).toEqual([]);

    projector.activate('s1');
    expect(projector.project('prompt.submitted', submitted, 's1')).toContainEqual(
      expect.objectContaining({ type: 'messageCreated' }),
    );
  });

  it('reactivates a released session when a snapshot resets its state', () => {
    const projector = createActiveProjector();
    projector.release('s1');

    const events = projector.seedInFlight('s1', {
      turnId: 1,
      assistantText: 'partial reply',
      thinkingText: '',
      runningTools: [],
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'messageCreated' }),
    );
    expect(
      projector.project('assistant.delta', { turnId: 1, delta: ' continued' }, 's1'),
    ).not.toEqual([]);
  });

  it('projects released-session metadata without reviving stream state', () => {
    const projector = createActiveProjector();
    projector.release('s1');

    expect(
      projector.project(
        'session.meta.updated',
        { patch: { title: 'Updated title', lastPrompt: 'hello' } },
        's1',
      ),
    ).toEqual([
      {
        type: 'sessionMetaUpdated',
        sessionId: 's1',
        title: 'Updated title',
        lastPrompt: 'hello',
      },
    ]);
    expect(
      projector.project('assistant.delta', { turnId: 1, delta: 'late' }, 's1'),
    ).toEqual([]);
  });

  it('keeps side-channel routing scoped to its parent session', () => {
    const projector = createAgentProjector();
    projector.markSideChannelAgent('agent_btw_1', 's1');
    projector.activate('s1');
    projector.activate('s2');

    expect(
      projector.project(
        'assistant.delta',
        { agentId: 'agent_btw_1', delta: 'side chat' },
        's1',
      ),
    ).toContainEqual(expect.objectContaining({ type: 'agentDelta' }));
    expect(
      projector.project(
        'assistant.delta',
        { agentId: 'agent_btw_1', delta: 'background task' },
        's2',
      ),
    ).not.toContainEqual(expect.objectContaining({ type: 'agentDelta' }));
  });

  it('keeps inactive side-channel routing until the chat is explicitly closed', () => {
    const projector = createActiveProjector();
    projector.markSideChannelAgent('agent_btw_1', 's1');
    projector.release('s1');

    expect(
      projector.project(
        'assistant.delta',
        { agentId: 'agent_btw_1', delta: 'side chat continues' },
        's1',
      ),
    ).toContainEqual(expect.objectContaining({ type: 'agentDelta' }));

    expect(
      projector.project(
        'tool.progress',
        { agentId: 'agent_btw_1', update: { text: 'tool output' } },
        's1',
      ),
    ).toContainEqual(expect.objectContaining({ type: 'agentDelta', agentId: 'agent_btw_1' }));

    expect(
      projector.project(
        'task.terminated',
        { agentId: 'agent_btw_1', info: { status: 'completed', outputPreview: 'done' } },
        's1',
      ),
    ).toEqual([
      expect.objectContaining({ type: 'agentDelta', agentId: 'agent_btw_1' }),
      expect.objectContaining({ type: 'agentTurnEnded', agentId: 'agent_btw_1' }),
    ]);

    projector.clearSideChannelAgent('agent_btw_1', 's1');
    expect(
      projector.project(
        'assistant.delta',
        { agentId: 'agent_btw_1', delta: 'closed chat' },
        's1',
      ),
    ).toEqual([]);
  });

  it('replaces the previous side-channel marker when a session opens a new one', () => {
    const projector = createActiveProjector();
    projector.markSideChannelAgent('agent_btw_old', 's1');
    projector.markSideChannelAgent('agent_btw_new', 's1');

    expect(
      projector.project(
        'assistant.delta',
        { agentId: 'agent_btw_old', delta: 'old agent' },
        's1',
      ),
    ).not.toContainEqual(expect.objectContaining({ type: 'agentDelta' }));
    expect(
      projector.project(
        'assistant.delta',
        { agentId: 'agent_btw_new', delta: 'new agent' },
        's1',
      ),
    ).toContainEqual(expect.objectContaining({ type: 'agentDelta' }));
  });

  it('binds a legacy unscoped side-channel marker to the first parent session', () => {
    const projector = createAgentProjector();
    projector.activate('s1');
    projector.activate('s2');
    projector.markSideChannelAgent('agent_btw_1');

    expect(
      projector.project(
        'assistant.delta',
        { agentId: 'agent_btw_1', delta: 'side chat' },
        's1',
      ),
    ).toContainEqual(expect.objectContaining({ type: 'agentDelta' }));
    expect(
      projector.project(
        'assistant.delta',
        { agentId: 'agent_btw_1', delta: 'background task' },
        's2',
      ),
    ).not.toContainEqual(expect.objectContaining({ type: 'agentDelta' }));
  });

  it('keeps released sessions inactive across repeated four-session waves', () => {
    const projector = createAgentProjector();
    const oneMiB = 'x'.repeat(1024 * 1024);
    const sessionIds: string[] = [];

    for (let wave = 0; wave < 24; wave += 1) {
      for (let slot = 0; slot < 4; slot += 1) {
        const sessionId = `session-${wave}-${slot}`;
        sessionIds.push(sessionId);
        projector.activate(sessionId);
        projector.project('turn.started', { turnId: 1 }, sessionId);
        projector.project('turn.step.started', { turnId: 1, step: 1 }, sessionId);
        projector.project('assistant.delta', { turnId: 1, delta: oneMiB }, sessionId);
        projector.release(sessionId);
      }
    }

    for (const sessionId of sessionIds) {
      expect(
        projector.project('assistant.delta', { turnId: 1, delta: 'late' }, sessionId),
      ).toEqual([]);
    }
  });
});
