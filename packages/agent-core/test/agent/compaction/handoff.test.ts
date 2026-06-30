import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_SUMMARY_PREFIX,
  buildCompactionSummaryText,
  collectCompactableUserMessages,
  compactionUserMessageDisposition,
  isCompactionSummaryMessage,
  isRealUserInput,
  selectRecentUserMessages,
  type CompactionUserDisposition,
} from '../../../src/agent/compaction';
import type { PromptOrigin } from '../../../src/agent/context/types';
import { estimateTokens, estimateTokensForMessage } from '../../../src/utils/tokens';

function textMessage(role: 'user' | 'assistant' | 'tool', text: string): Message {
  return { role, content: [{ type: 'text', text }], toolCalls: [] };
}

function messageText(message: Message): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

const ALL_PROMPT_ORIGIN_KINDS = {
  user: true,
  skill_activation: true,
  plugin_command: true,
  injection: true,
  shell_command: true,
  compaction_summary: true,
  system_trigger: true,
  background_task: true,
  cron_job: true,
  cron_missed: true,
  hook_result: true,
  retry: true,
} satisfies Record<PromptOrigin['kind'], true>;

const EXPECTED_DISPOSITION: Record<PromptOrigin['kind'], CompactionUserDisposition> = {
  user: 'keep',
  skill_activation: 'keep',
  plugin_command: 'keep',
  injection: 'drop',
  shell_command: 'drop',
  compaction_summary: 'drop',
  system_trigger: 'drop',
  background_task: 'drop',
  cron_job: 'drop',
  cron_missed: 'drop',
  hook_result: 'drop',
  retry: 'drop',
};

function originForKind(kind: PromptOrigin['kind']): PromptOrigin {
  switch (kind) {
    case 'user':
      return { kind: 'user' };
    case 'skill_activation':
      return {
        kind: 'skill_activation',
        activationId: 'activation',
        skillName: 'skill',
        trigger: 'user-slash',
      };
    case 'plugin_command':
      return {
        kind: 'plugin_command',
        activationId: 'activation',
        pluginId: 'plugin',
        commandName: 'command',
        trigger: 'user-slash',
      };
    case 'injection':
      return { kind: 'injection', variant: 'system_reminder' };
    case 'shell_command':
      return { kind: 'shell_command', phase: 'input' };
    case 'compaction_summary':
      return { kind: 'compaction_summary' };
    case 'system_trigger':
      return { kind: 'system_trigger', name: 'system' };
    case 'background_task':
      return {
        kind: 'background_task',
        taskId: 'task',
        status: 'completed',
        notificationId: 'notification',
      };
    case 'cron_job':
      return {
        kind: 'cron_job',
        jobId: 'job',
        cron: '* * * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      };
    case 'cron_missed':
      return { kind: 'cron_missed', count: 1 };
    case 'hook_result':
      return { kind: 'hook_result', event: 'PreCompact' };
    case 'retry':
      return { kind: 'retry', trigger: 'system' };
  }
}

describe('isCompactionSummaryMessage', () => {
  it('detects the compaction origin', () => {
    const message = {
      ...textMessage('user', 'anything'),
      origin: { kind: 'compaction_summary' as const },
    };
    expect(isCompactionSummaryMessage(message)).toBe(true);
  });

  it('keeps real user prompts even when they start with the summary prefix', () => {
    const message = {
      ...textMessage('user', `${COMPACTION_SUMMARY_PREFIX}\nsummary`),
      origin: { kind: 'user' as const },
    };

    expect(isCompactionSummaryMessage(message)).toBe(false);
    expect(collectCompactableUserMessages([message])).toEqual([message]);
  });

  it('ignores ordinary user messages', () => {
    expect(isCompactionSummaryMessage(textMessage('user', 'hello'))).toBe(false);
  });
});

describe('compactionUserMessageDisposition', () => {
  it('classifies every prompt origin kind', () => {
    for (const kind of Object.keys(ALL_PROMPT_ORIGIN_KINDS) as Array<PromptOrigin['kind']>) {
      expect(compactionUserMessageDisposition(originForKind(kind))).toBe(EXPECTED_DISPOSITION[kind]);
    }
  });

  it('drops model-triggered skill activations', () => {
    expect(
      compactionUserMessageDisposition({
        kind: 'skill_activation',
        activationId: 'activation',
        skillName: 'skill',
        trigger: 'model-tool',
      }),
    ).toBe('drop');
  });
});

describe('isRealUserInput', () => {
  it('keeps genuine user input and drops other origins', () => {
    expect(isRealUserInput({ ...textMessage('user', 'hello'), origin: originForKind('user') })).toBe(
      true,
    );
    expect(
      isRealUserInput({ ...textMessage('user', 'hello'), origin: originForKind('skill_activation') }),
    ).toBe(true);
    expect(
      isRealUserInput({ ...textMessage('user', 'hello'), origin: originForKind('injection') }),
    ).toBe(false);
    expect(
      isRealUserInput({ ...textMessage('user', 'hello'), origin: originForKind('shell_command') }),
    ).toBe(false);
    expect(
      isRealUserInput({ ...textMessage('user', 'hello'), origin: originForKind('background_task') }),
    ).toBe(false);
  });
});

describe('collectCompactableUserMessages', () => {
  it('keeps only user messages', () => {
    const messages = [
      textMessage('user', 'u1'),
      textMessage('assistant', 'a1'),
      textMessage('tool', 't1'),
      textMessage('user', 'u2'),
    ];

    expect(collectCompactableUserMessages(messages).map(messageText)).toEqual(['u1', 'u2']);
  });

  it('drops previous compaction summaries', () => {
    const summary = {
      ...textMessage('user', `${COMPACTION_SUMMARY_PREFIX}\nold summary`),
      origin: { kind: 'compaction_summary' as const },
    };
    const messages = [textMessage('user', 'u1'), summary, textMessage('user', 'u2')];

    expect(collectCompactableUserMessages(messages).map(messageText)).toEqual(['u1', 'u2']);
  });
});

describe('selectRecentUserMessages', () => {
  it('keeps the most recent messages within the budget', () => {
    const messages = [
      textMessage('user', 'old'),
      textMessage('user', 'mid'),
      textMessage('user', 'recent'),
    ];
    const budget = estimateTokensForMessage(messages[1]!) + estimateTokensForMessage(messages[2]!);

    expect(selectRecentUserMessages(messages, budget).map(messageText)).toEqual(['mid', 'recent']);
  });

  it('truncates the oldest kept message when it would overflow the budget', () => {
    const long = 'x'.repeat(1_000);
    const messages = [textMessage('user', long), textMessage('user', 'recent')];
    const budget = estimateTokensForMessage(messages[1]!) + 10;

    const selected = selectRecentUserMessages(messages, budget);

    expect(selected).toHaveLength(2);
    expect(estimateTokens(messageText(selected[0]!))).toBeLessThanOrEqual(10);
    expect(messageText(selected[1]!)).toBe('recent');
  });

  it('truncates a CJK-heavy oldest message within the budget in one pass', () => {
    const cjk = '中'.repeat(40_000);
    const messages = [textMessage('user', cjk), textMessage('user', 'recent')];
    const budget = estimateTokensForMessage(messages[1]!) + 1_000;

    const selected = selectRecentUserMessages(messages, budget);

    expect(selected).toHaveLength(2);
    expect(messageText(selected[1]!)).toBe('recent');
    expect(estimateTokens(messageText(selected[0]!))).toBeLessThanOrEqual(1_000);
    expect(cjk.startsWith(messageText(selected[0]!))).toBe(true);
  });

  it('does not split surrogate pairs while truncating emoji text', () => {
    const emoji = '😀'.repeat(2_000);
    const messages = [textMessage('user', emoji), textMessage('user', 'recent')];
    const budget = estimateTokensForMessage(messages[1]!) + 333;

    const selected = selectRecentUserMessages(messages, budget);
    const truncated = messageText(selected[0]!);

    expect(selected).toHaveLength(2);
    expect(messageText(selected[1]!)).toBe('recent');
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(333);
    expect(/^(?:😀)*$/u.test(truncated)).toBe(true);
    expect(truncated.length % 2).toBe(0);
  });

  it('returns nothing when the budget is zero', () => {
    expect(selectRecentUserMessages([textMessage('user', 'hi')], 0)).toEqual([]);
  });
});

describe('buildCompactionSummaryText', () => {
  it('prefixes the summary', () => {
    expect(buildCompactionSummaryText('Summary.')).toBe(`${COMPACTION_SUMMARY_PREFIX}\nSummary.`);
  });

  it('falls back when the summary is empty', () => {
    expect(buildCompactionSummaryText('   ')).toBe(`${COMPACTION_SUMMARY_PREFIX}\n(no summary available)`);
  });
});
