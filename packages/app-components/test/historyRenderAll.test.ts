import { describe, expect, it } from 'vitest';
import type { ChatTurn, ToolCall, TurnBlock } from '@moonshot-ai/app-core/client/types';
import { historyRenderAllAffordable } from '../src/chatTurnRendering';

function userTurn(no: number): ChatTurn {
  return { id: `u${no}`, role: 'user', no, text: `question ${no}`, title: '', status: 'done' } as unknown as ChatTurn;
}

function assistantTurn(no: number, toolCount: number): ChatTurn {
  const tools: ToolCall[] = Array.from({ length: toolCount }, (_, i) => ({ id: `t${no}-${i}`, name: 'Read', arg: '{}', status: 'ok' }) as ToolCall);
  const blocks: TurnBlock[] = [{ kind: 'text', text: 'done' }, ...tools.map((tool): TurnBlock => ({ kind: 'tool', tool }))];
  return { id: `a${no}`, role: 'assistant', no, text: 'done', tools, blocks } as unknown as ChatTurn;
}

describe('historyRenderAllAffordable', () => {
  it('renders an empty or small conversation without windowing', () => {
    expect(historyRenderAllAffordable([])).toBe(true);
    const turns = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? userTurn(i) : assistantTurn(i, 4)));
    expect(historyRenderAllAffordable(turns)).toBe(true);
  });

  it('windows once the conversation has many turns', () => {
    const turns = Array.from({ length: 41 }, (_, i) => userTurn(i));
    expect(historyRenderAllAffordable(turns)).toBe(false);
  });

  it('windows a short conversation whose turns carry many blocks', () => {
    const turns = [userTurn(1), assistantTurn(2, 300), userTurn(3)];
    expect(historyRenderAllAffordable(turns)).toBe(false);
  });

  it('falls back to the tool count when blocks are absent', () => {
    const heavy = { ...assistantTurn(2, 300), blocks: undefined } as ChatTurn;
    expect(historyRenderAllAffordable([userTurn(1), heavy])).toBe(false);
    const light = { ...assistantTurn(2, 3), blocks: undefined } as ChatTurn;
    expect(historyRenderAllAffordable([userTurn(1), light])).toBe(true);
  });
});
