// apps/kimi-web/test/user-origin.test.ts
//
// TUI parity (isReplayUserTurnRecord): user-role messages are only displayed
// when they are real user input — origin absent/'user', or a user-typed slash
// command. System-injected user messages (compaction summaries, hook results,
// background-task notifications, cron, retries…) must stay hidden.

import { describe, expect, it } from 'vitest';
import { messagesToTurns } from '../src/composables/messagesToTurns';
import type { AppMessage } from '../src/api/types';

let n = 0;
function userMsg(text: string, origin?: Record<string, unknown>): AppMessage {
  n += 1;
  return {
    id: `m_${n}`,
    sessionId: 'sess_1',
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: new Date(1700000000000 + n * 1000).toISOString(),
    ...(origin !== undefined ? { metadata: { origin } } : {}),
  } as AppMessage;
}

function shownTexts(messages: AppMessage[]): string[] {
  return messagesToTurns(messages, [])
    .filter((t) => t.role === 'user')
    .map((t) => t.text);
}

describe('user message origin filtering (TUI parity)', () => {
  it('shows plain user input (no origin / origin user)', () => {
    expect(shownTexts([userMsg('hi'), userMsg('there', { kind: 'user' })])).toEqual(['hi', 'there']);
  });

  it('shows user-typed slash commands, hides model/nested skill activations', () => {
    expect(
      shownTexts([
        userMsg('body', { kind: 'skill_activation', trigger: 'user-slash', skillName: 'compact', skillArgs: '/compact' }),
        userMsg('skill body', { kind: 'skill_activation', trigger: 'model-tool', skillName: 'review' }),
        userMsg('nested', { kind: 'skill_activation', trigger: 'nested-skill', skillName: 'brainstorm' }),
      ]),
    ).toEqual(['/compact']);
  });

  it('strips XML body and surfaces skillActivation metadata for slash skills', () => {
    const turns = messagesToTurns(
      [
        userMsg('User activated the skill "review". Follow the loaded skill instructions.\n\n<kimi-skill-loaded name="review" trigger="user-slash" source="project" args="src/app.ts">\nbody\n</kimi-skill-loaded>', {
          kind: 'skill_activation',
          trigger: 'user-slash',
          skillName: 'review',
          skillArgs: 'src/app.ts',
        }),
      ],
      [],
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe('user');
    expect(turns[0]!.text).toBe('src/app.ts');
    expect(turns[0]!.skillActivation).toEqual({ name: 'review', args: 'src/app.ts' });
  });

  it.each([
    ['compaction_summary'],
    ['injection'],
    ['system_trigger'],
    ['background_task'],
    ['cron_job'],
    ['cron_missed'],
    ['hook_result'],
    ['retry'],
  ])('hides origin kind %s', (kind) => {
    expect(shownTexts([userMsg('visible'), userMsg('hidden', { kind })])).toEqual(['visible']);
  });
});
