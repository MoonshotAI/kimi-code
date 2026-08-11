import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent } from '../../src/renderer/api/types';
import { messagesToTurns } from '@moonshot-ai/app-core/client';

function message(
  id: string,
  role: AppMessage['role'],
  content: AppMessageContent[],
  extra: Partial<AppMessage> = {},
): AppMessage {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

// Regression for kimi-code#2323: third-party OpenAI-compatible providers can
// persist one text part per stream chunk, so a history reload must concatenate
// adjacent same-kind parts within ONE message verbatim — joining them with
// '\n' renders long replies as vertical text.
describe('messagesToTurns stream-chunk parts', () => {
  it('concatenates chunked text parts within one assistant message verbatim', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'text', text: 'grad' },
          { type: 'text', text: 'lew' },
          { type: 'text', text: '\n\nDone.' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('gradlew\n\nDone.');
    expect(turns[0]?.blocks).toEqual([{ kind: 'text', text: 'gradlew\n\nDone.' }]);
  });

  it('concatenates chunked thinking parts verbatim, merging their timing', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          {
            type: 'thinking',
            thinking: 'pla',
            startedAt: '2026-01-01T00:00:00.000Z',
            durationMs: 100,
          },
          {
            type: 'thinking',
            thinking: 'n',
            startedAt: '2026-01-01T00:00:00.100Z',
            durationMs: 100,
          },
          { type: 'text', text: 'answer' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]?.thinking).toBe('plan');
    expect(turns[0]?.blocks?.[0]).toMatchObject({
      kind: 'thinking',
      thinking: 'plan',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 200,
    });
  });

  it('keeps a newline between text segments from separate messages of one turn', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'step one' }]),
        message('a2', 'assistant', [{ type: 'text', text: 'step two' }]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('step one\nstep two');
    expect(turns[0]?.blocks).toEqual([{ kind: 'text', text: 'step one\nstep two' }]);
  });

  it('keeps text segments split by a tool call as separate blocks', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'text', text: 'before' },
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'read', input: { path: 'a.ts' } },
          { type: 'text', text: 'after' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]?.text).toBe('before\nafter');
    expect(turns[0]?.blocks?.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
  });

  it('dedupes a chunked persisted copy against its assembled live copy', () => {
    const chunked: AppMessageContent[] = [
      { type: 'text', text: 'grad' },
      { type: 'text', text: 'lew' },
    ];
    const assembled: AppMessageContent[] = [{ type: 'text', text: 'gradlew' }];
    const orders: [AppMessageContent[], AppMessageContent[]][] = [
      [assembled, chunked],
      [chunked, assembled],
    ];
    for (const [first, second] of orders) {
      const turns = messagesToTurns(
        [
          message('a1', 'assistant', first, { promptId: 'p1' }),
          message('a2', 'assistant', second, { promptId: 'p1' }),
        ],
        [],
        undefined,
        false,
      );

      expect(turns).toHaveLength(1);
      expect(turns[0]?.text).toBe('gradlew');
    }
  });
});
