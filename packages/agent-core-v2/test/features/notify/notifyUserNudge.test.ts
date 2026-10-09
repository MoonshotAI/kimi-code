import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  NOTIFY_USER_NUDGE_THRESHOLD,
  notifyStreak,
  notifyStreakBefore,
  renderNotifyUserNudge,
  shouldNudgeNotifyUser,
  toolCallRoundsSincePosition,
} from '#/features/notify/notifyUserNudge';

function userPrompt(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'do the thing' }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function nudgeInjection(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'nudge' }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'notify_user_nudge' },
  };
}

function cronPrompt(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'cron fired' }],
    toolCalls: [],
    origin: {
      kind: 'cron_job',
      jobId: 'j1',
      cron: '* * * * *',
      recurring: true,
      coalescedCount: 0,
      stale: false,
    },
  };
}

function slashSkillPrompt(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: '/review' }],
    toolCalls: [],
    origin: { kind: 'skill_activation', activationId: 'a1', skillName: 'review', trigger: 'user-slash' },
  };
}

function modelSkillPrompt(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'skill content' }],
    toolCalls: [],
    origin: { kind: 'skill_activation', activationId: 'a2', skillName: 'pdf', trigger: 'model-tool' },
  };
}

function taskPrompt(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'task finished' }],
    toolCalls: [],
    origin: { kind: 'task', taskId: 't1', status: 'completed', notificationId: 'n1' },
  };
}

function retryPrompt(): ContextMessage {
  return {
    role: 'user',
    content: [],
    toolCalls: [],
    origin: { kind: 'retry' },
  };
}

function subagentTriggerPrompt(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'resume the subagent' }],
    toolCalls: [],
    origin: { kind: 'system_trigger', name: 'subagent' },
  };
}

function stopHookContinuation(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'stop hook asks to continue' }],
    toolCalls: [],
    origin: { kind: 'system_trigger', name: 'stop_hook' },
  };
}

function assistantWithTools(...names: string[]): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: names.map((name, index) => ({
      type: 'function' as const,
      id: `call_${index}`,
      name,
      arguments: '{}',
    })),
  };
}

describe('notifyStreak', () => {
  it('counts one round per assistant step back to the user prompt, however many calls it batched', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash', 'Read', 'Grep', 'Glob'),
      assistantWithTools('Grep'),
    ];

    expect(notifyStreak(history).rounds).toBe(2);
  });

  it('does not count assistant messages without tool calls', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash'),
      { role: 'assistant', content: [{ type: 'text', text: 'Interim note.' }], toolCalls: [] },
      assistantWithTools('Read'),
    ] satisfies ContextMessage[];

    expect(notifyStreak(history).rounds).toBe(2);
  });

  it('counts only the calls after the latest NotifyUser call', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash', 'Read', 'Grep'),
      assistantWithTools('NotifyUser', 'Bash'),
      assistantWithTools('Bash'),
    ];

    expect(notifyStreak(history).rounds).toBe(1);
  });

  it('stops at the previous turn', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      userPrompt(),
      assistantWithTools('Read'),
    ];

    expect(notifyStreak(history).rounds).toBe(1);
  });

  it('stops at non-user turn boundaries such as cron and slash-skill prompts', () => {
    const cronTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      cronPrompt(),
      assistantWithTools('Read'),
    ];
    expect(notifyStreak(cronTurn).rounds).toBe(1);

    const slashTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      slashSkillPrompt(),
      assistantWithTools('Read'),
    ];
    expect(notifyStreak(slashTurn).rounds).toBe(1);
  });

  it('does not stop at a model-invoked skill in the middle of a turn', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash'),
      modelSkillPrompt(),
      assistantWithTools('Read'),
    ];

    expect(notifyStreak(history).rounds).toBe(2);
  });

  it('stops at task-notification and retry boundaries', () => {
    const taskTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      taskPrompt(),
      assistantWithTools('Read'),
    ];
    expect(notifyStreak(taskTurn).rounds).toBe(1);

    const retryTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      retryPrompt(),
      assistantWithTools('Read'),
    ];
    expect(notifyStreak(retryTurn).rounds).toBe(1);
  });

  it('stops at a subagent system trigger but not at a stop-hook continuation', () => {
    const subagentTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      subagentTriggerPrompt(),
      assistantWithTools('Read'),
    ];
    expect(notifyStreak(subagentTurn).rounds).toBe(1);

    const continued = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash'),
      stopHookContinuation(),
      assistantWithTools('Read'),
    ];
    expect(notifyStreak(continued).rounds).toBe(2);
  });
});

describe('notifyStreak nudges', () => {
  it('counts reminders injected since the last NotifyUser call', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash'),
      nudgeInjection(),
      assistantWithTools('NotifyUser'),
      assistantWithTools('Bash'),
      nudgeInjection(),
      assistantWithTools('Read'),
      nudgeInjection(),
    ];

    expect(notifyStreak(history)).toEqual({ rounds: 2, nudges: 2 });
  });
});

describe('notifyStreakBefore', () => {
  it('measures the streak that precedes the step carrying the given call', () => {
    const notifying: ContextMessage = {
      role: 'assistant',
      content: [],
      toolCalls: [
        { type: 'function', id: 'call_notify', name: 'NotifyUser', arguments: '{}' },
        { type: 'function', id: 'call_read', name: 'Read', arguments: '{}' },
      ],
    };
    const history = [
      userPrompt(),
      assistantWithTools('Bash', 'Grep'),
      nudgeInjection(),
      assistantWithTools('Read'),
      notifying,
    ];

    expect(notifyStreakBefore(history, 'call_notify')).toEqual({ rounds: 2, nudges: 1 });
  });
});

describe('toolCallRoundsSincePosition', () => {
  it('counts every tool-call round after the given history position', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash'),
      nudgeInjection(),
      assistantWithTools('Bash', 'Read'),
      assistantWithTools('Grep'),
    ];

    expect(toolCallRoundsSincePosition(history, 2)).toBe(2);
    expect(toolCallRoundsSincePosition(history, 0)).toBe(3);
  });
});

describe('shouldNudgeNotifyUser', () => {
  it('stays quiet below the threshold', () => {
    expect(shouldNudgeNotifyUser(NOTIFY_USER_NUDGE_THRESHOLD - 1, null)).toBe(false);
  });

  it('fires at the threshold when it never nudged before', () => {
    expect(shouldNudgeNotifyUser(NOTIFY_USER_NUDGE_THRESHOLD, null)).toBe(true);
  });

  it('spaces nudges by the threshold while a silent streak continues', () => {
    expect(shouldNudgeNotifyUser(NOTIFY_USER_NUDGE_THRESHOLD * 2, 3)).toBe(false);
    expect(shouldNudgeNotifyUser(NOTIFY_USER_NUDGE_THRESHOLD * 2, NOTIFY_USER_NUDGE_THRESHOLD)).toBe(
      true,
    );
  });

  it('re-arms at the threshold after the model notified (streak reset)', () => {
    expect(shouldNudgeNotifyUser(NOTIFY_USER_NUDGE_THRESHOLD, 40)).toBe(true);
  });
});

describe('renderNotifyUserNudge', () => {
  it('mentions the count and the ask', () => {
    const text = renderNotifyUserNudge(8);
    expect(text).toContain('8 rounds of tool calls');
    expect(text).toContain('NotifyUser');
  });
});
