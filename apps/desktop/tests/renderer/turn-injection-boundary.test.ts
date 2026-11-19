import { describe, expect, it } from 'vitest';
import { conversationToTurns } from '@moonshot-ai/app-core/client';
import type { ConversationItem, ConversationTurn, UserMessageItem } from '@moonshot-ai/app-core/conversation';
import { splitAssistantFold } from '@moonshot-ai/app-components/support';

describe('conversationToTurns final answer rounds', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const tool = (id: string, step: number, name = 'Bash'): ConversationItem => ({
    type: 'tool_call',
    item_id: id,
    status: 'ended',
    outcome: 'completed',
    step_index: step,
    created_at: at,
    started_at: at,
    name,
    input: { command: 'pnpm build' },
    output: 'build ok',
  });
  const answer = (id: string, step: number, text: string): ConversationItem => ({
    type: 'assistant_message',
    item_id: id,
    status: 'ended',
    outcome: 'completed',
    step_index: step,
    created_at: at,
    text,
  });
  const notificationItem = (id: string): ConversationItem => ({
    type: 'notification',
    item_id: id,
    status: 'ended',
    outcome: 'completed',
    created_at: at,
    notification_id: `task:build-1:${id}`,
    title: 'Background process completed',
    body: 'Build finished.',
    severity: 'info',
    notification_type: 'task.completed',
    source: { kind: 'background_task', id: 'build-1' },
  });
  const user = (id: string, placement: 'opener' | 'steer', text: string): UserMessageItem => ({
    type: 'user_message',
    item_id: id,
    status: 'ended',
    outcome: 'completed',
    created_at: at,
    placement,
    prompt_ids: [id],
    origin: { kind: 'user' },
    text,
    attachments: [],
    skills: [],
  });
  const turn = (ordinal: number, items: ConversationItem[]): ConversationTurn => ({
    turn_id: `t${ordinal}`,
    ordinal,
    turn_number: ordinal + 1,
    kind: 'agent',
    status: 'ended',
    outcome: 'completed',
    started_at: at,
    steps: [],
    items,
  });
  const project = (turns: ConversationTurn[]) => conversationToTurns(turns, { sessionId: 'session-1' });
  const assistantOf = (turns: ReturnType<typeof project>) => turns.find((item) => item.role === 'assistant')!;

  it('keeps the first final answer visible when a background notification starts the next round', () => {
    const { folded, visible } = splitAssistantFold(assistantOf(project([turn(0, [
      user('prompt-1', 'opener', 'Check the build'),
      tool('call-1', 1),
      answer('first-final', 2, 'First final answer'),
      notificationItem('notification-1'),
      tool('call-2', 3, 'Read'),
      answer('second-final', 4, 'Second final answer'),
    ])])));
    expect(folded.map((block) => block.kind)).toEqual(['tool']);
    expect(visible.map((block) => block.kind)).toEqual(['text', 'notification', 'tool', 'text']);
    expect(visible[0]).toMatchObject({ text: 'First final answer' });
    expect(visible.at(-1)).toMatchObject({ text: 'Second final answer' });
  });

  it('keeps only the latest answer visible within an uninterrupted round', () => {
    const { folded, visible } = splitAssistantFold(assistantOf(project([turn(0, [
      user('prompt-1', 'opener', 'Check the build'),
      tool('call-1', 1),
      answer('draft', 1, 'Draft answer'),
      tool('call-2', 2, 'Read'),
      answer('latest', 2, 'Latest answer'),
    ])])));
    expect(folded.map((block) => block.kind)).toEqual(['tool', 'text', 'tool']);
    expect(visible).toEqual([expect.objectContaining({ kind: 'text', text: 'Latest answer' })]);
  });

  it('keeps only the latest answer visible when a notification stays in the same round', () => {
    const { folded, visible } = splitAssistantFold(assistantOf(project([turn(0, [
      user('prompt-1', 'opener', 'Check the build'),
      answer('earlier', 1, 'Earlier answer'),
      notificationItem('notification-1'),
      answer('latest', 1, 'Latest answer'),
    ])])));
    expect(folded.map((block) => block.kind)).toEqual(['text', 'notification']);
    expect(visible).toEqual([expect.objectContaining({ kind: 'text', text: 'Latest answer' })]);
  });

  it('keeps only the final answer before a steered user message visible', () => {
    const turns = project([turn(0, [
      user('prompt-1', 'opener', 'Check the build'),
      answer('draft', 1, 'Draft answer'),
      answer('before-steer', 1, 'Final before steer'),
      user('prompt-steer', 'steer', 'Continue with a screenshot'),
      answer('after-steer', 2, 'Answer after steer'),
    ])]);
    expect(turns.map((item) => item.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const before = splitAssistantFold(turns[1]!);
    expect(before.folded).toEqual([expect.objectContaining({ kind: 'text', text: 'Draft answer' })]);
    expect(before.visible).toEqual([expect.objectContaining({ kind: 'text', text: 'Final before steer' })]);
    expect(turns[2]).toMatchObject({ role: 'user', steered: true, text: 'Continue with a screenshot' });
    expect(splitAssistantFold(turns[3]!).visible).toEqual([
      expect.objectContaining({ kind: 'text', text: 'Answer after steer' }),
    ]);
  });

  it('continues the previous answer through a turn a notification opened', () => {
    const turns = project([
      turn(0, [answer('first', 1, 'First final')]),
      turn(1, [notificationItem('notification-1'), answer('latest', 1, 'Latest final')]),
    ]);
    expect(turns).toHaveLength(1);
    const { folded, visible } = splitAssistantFold(turns[0]!);
    expect(folded).toEqual([]);
    expect(visible.map((block) => block.kind)).toEqual(['text', 'notification', 'text']);
    expect(visible[0]).toMatchObject({ text: 'First final' });
    expect(visible.at(-1)).toMatchObject({ text: 'Latest final' });
  });

  it('marks the turn a goal continuation opens, even before its answer or after a notification lands first', () => {
    const goal: UserMessageItem = { ...user('goal-1', 'opener', ''), prompt_ids: [], origin: { kind: 'goal' } };
    const turns = project([
      turn(0, [goal, notificationItem('notification-1'), answer('noted', 1, 'Noted')]),
      turn(1, [{ ...goal, item_id: 'goal-2' }]),
    ]);
    expect(turns.map((item) => [item.role, item.goalContinuation])).toEqual([
      ['goal', undefined],
      ['assistant', true],
      ['goal', undefined],
      ['assistant', true],
    ]);
    expect(turns[1]?.blocks?.map((block) => block.kind)).toEqual(['notification', 'text']);
    expect(turns[3]).toMatchObject({ text: '', blocks: undefined });
  });
});
