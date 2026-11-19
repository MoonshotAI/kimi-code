import { describe, expect, it } from 'vitest';
import type { ChatTurn, ToolCall, TurnBlock } from '../../src/renderer/types';
import { assistantRenderBlocks, turnToMarkdown } from '@moonshot-ai/app-components';

function tool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'read', arg: `· ${id}.ts`, status: 'ok', ...over };
}

function toolBlock(id: string, over: Partial<ToolCall> = {}): Extract<TurnBlock, { kind: 'tool' }> {
  return { kind: 'tool', tool: tool(id, over) };
}

function ntfBlock(id: string, type = 'task.completed'): Extract<TurnBlock, { kind: 'notification' }> {
  return {
    kind: 'notification',
    notification: {
      id,
      type,
      sourceKind: 'background_task',
      sourceId: id,
      severity: 'info',
      title: 'task',
      body: `task ${id}`,
      raw: '{}',
    },
  };
}

function assistantTurn(blocks: TurnBlock[], over: Partial<ChatTurn> = {}): ChatTurn {
  return { id: 't1', role: 'assistant', no: 1, text: '', blocks, ...over };
}

describe('assistantRenderBlocks', () => {
  it('keeps a run whole across request debugs and carries each debug with its item', () => {
    const debug = { finish_reason: 'tool_use' };
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('a'), { ...toolBlock('b'), debug: [debug] }, { kind: 'text', text: 'done', debug: [debug] }]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run', 'text']);
    expect(rendered[0]?.kind === 'activity-run' && rendered[0].items.map((item) => item.debug)).toEqual([undefined, [debug]]);
    expect(rendered[1]).toMatchObject({ kind: 'text', debug: [debug] });
  });
});

describe('turnToMarkdown', () => {
  it('keeps the notification output preview in the copy as a fenced block', () => {
    const turn = assistantTurn([ntfBlock('n1')]);
    const block = turn.blocks?.[0];
    if (block?.kind === 'notification')
      block.notification = {
        ...block.notification,
        outputPreview: { text: 'line a\nline b', bytes: 100, truncated: true },
      };
    expect(turnToMarkdown(turn)).toBe(
      '> **Notification**\n> task\n> task.completed\n> task n1\n\n```\n[output-preview]\nline a\nline b\n```',
    );
  });
});
