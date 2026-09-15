import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  NOTIFY_USER_NUDGE_THRESHOLD,
  lastMidResponsePosition,
  renderNotifyUserNudge,
  shouldNudgeMidResponse,
  shouldNudgeNotifyUser,
  toolCallsSinceLastNotify,
  toolCallsSincePosition,
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

function assistantWithText(text: string, ...tools: string[]): ContextMessage {
  const message = assistantWithTools(...tools);
  return { ...message, content: [{ type: 'text', text }] };
}

function assistantWithThink(think: string, ...tools: string[]): ContextMessage {
  const message = assistantWithTools(...tools);
  return { ...message, content: [{ type: 'think', think }] };
}

describe('toolCallsSinceLastNotify', () => {
  it('counts tool calls back to the user prompt when nothing was notified', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash', 'Read'),
      assistantWithTools('Grep'),
    ];

    expect(toolCallsSinceLastNotify(history)).toBe(3);
  });

  it('counts only the calls after the latest NotifyUser call', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash', 'Read', 'Grep'),
      assistantWithTools('NotifyUser', 'Bash'),
      assistantWithTools('Bash'),
    ];

    expect(toolCallsSinceLastNotify(history)).toBe(1);
  });

  it('stops at the previous turn', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      userPrompt(),
      assistantWithTools('Read'),
    ];

    expect(toolCallsSinceLastNotify(history)).toBe(1);
  });

  it('stops at non-user turn boundaries such as cron and slash-skill prompts', () => {
    const cronTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      cronPrompt(),
      assistantWithTools('Read'),
    ];
    expect(toolCallsSinceLastNotify(cronTurn)).toBe(1);

    const slashTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      slashSkillPrompt(),
      assistantWithTools('Read'),
    ];
    expect(toolCallsSinceLastNotify(slashTurn)).toBe(1);
  });

  it('does not stop at a model-invoked skill in the middle of a turn', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash'),
      modelSkillPrompt(),
      assistantWithTools('Read'),
    ];

    expect(toolCallsSinceLastNotify(history)).toBe(3);
  });

  it('stops at task-notification and retry boundaries', () => {
    const taskTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      taskPrompt(),
      assistantWithTools('Read'),
    ];
    expect(toolCallsSinceLastNotify(taskTurn)).toBe(1);

    const retryTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      retryPrompt(),
      assistantWithTools('Read'),
    ];
    expect(toolCallsSinceLastNotify(retryTurn)).toBe(1);
  });

  it('stops at a subagent system trigger but not at a stop-hook continuation', () => {
    const subagentTurn = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash', 'Bash'),
      subagentTriggerPrompt(),
      assistantWithTools('Read'),
    ];
    expect(toolCallsSinceLastNotify(subagentTurn)).toBe(1);

    const continued = [
      userPrompt(),
      assistantWithTools('Bash', 'Bash'),
      stopHookContinuation(),
      assistantWithTools('Read'),
    ];
    expect(toolCallsSinceLastNotify(continued)).toBe(3);
  });
});

describe('toolCallsSincePosition', () => {
  it('counts every tool call after the given history position', () => {
    const history = [
      userPrompt(),
      assistantWithTools('Bash'),
      nudgeInjection(),
      assistantWithTools('Bash', 'Read'),
      assistantWithTools('Grep'),
    ];

    expect(toolCallsSincePosition(history, 2)).toBe(3);
    expect(toolCallsSincePosition(history, 0)).toBe(4);
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

describe('lastMidResponsePosition', () => {
  it('finds the latest assistant message carrying visible text', () => {
    const history = [
      userPrompt(),
      assistantWithText('我来搜索一下', 'WebSearch'),
      assistantWithTools('FetchURL'),
    ];

    expect(lastMidResponsePosition(history)).toBe(1);
  });

  it('ignores thinking-only messages', () => {
    const history = [
      userPrompt(),
      assistantWithThink('让我想想', 'WebSearch'),
      assistantWithTools('FetchURL'),
    ];

    expect(lastMidResponsePosition(history)).toBe(-1);
  });

  it('stops at the last NotifyUser call and at the turn boundary', () => {
    const notified = [
      userPrompt(),
      assistantWithText('早期说过的话', 'Bash'),
      assistantWithTools('NotifyUser'),
      assistantWithTools('Bash'),
    ];
    expect(lastMidResponsePosition(notified)).toBe(-1);

    const previousTurn = [
      assistantWithText('上一轮的正文', 'Bash'),
      userPrompt(),
      assistantWithTools('Bash'),
    ];
    expect(lastMidResponsePosition(previousTurn)).toBe(-1);
  });

  it('does not treat the previous turn\'s reply as mid-response across non-user boundaries', () => {
    const acrossCron = [
      assistantWithText('上一轮的正文', 'Bash'),
      cronPrompt(),
      assistantWithTools('Bash'),
    ];
    expect(lastMidResponsePosition(acrossCron)).toBe(-1);

    const acrossSlashSkill = [
      assistantWithText('上一轮的正文', 'Bash'),
      slashSkillPrompt(),
      assistantWithTools('Bash'),
    ];
    expect(lastMidResponsePosition(acrossSlashSkill)).toBe(-1);

    const acrossTask = [
      assistantWithText('上一轮的正文', 'Bash'),
      taskPrompt(),
      assistantWithTools('Bash'),
    ];
    expect(lastMidResponsePosition(acrossTask)).toBe(-1);

    const acrossRetry = [
      assistantWithText('上一轮的正文', 'Bash'),
      retryPrompt(),
      assistantWithTools('Bash'),
    ];
    expect(lastMidResponsePosition(acrossRetry)).toBe(-1);
  });

  it('still finds mid-turn text that precedes a stop-hook continuation', () => {
    const history = [
      userPrompt(),
      assistantWithText('中段说明', 'WebSearch'),
      stopHookContinuation(),
      assistantWithTools('FetchURL'),
    ];

    expect(lastMidResponsePosition(history)).toBe(1);
  });
});

describe('shouldNudgeMidResponse', () => {
  it('stays quiet without a mid-response or when already nudged after it', () => {
    expect(shouldNudgeMidResponse(-1, null)).toBe(false);
    expect(shouldNudgeMidResponse(3, 3)).toBe(false);
    expect(shouldNudgeMidResponse(3, 5)).toBe(false);
  });

  it('fires once for each new mid-response', () => {
    expect(shouldNudgeMidResponse(3, null)).toBe(true);
    expect(shouldNudgeMidResponse(5, 3)).toBe(true);
  });
});

describe('renderNotifyUserNudge', () => {
  it('mentions the count and the ask', () => {
    const text = renderNotifyUserNudge(8);
    expect(text).toContain('8 tool calls');
    expect(text).toContain('NotifyUser');
  });
});
