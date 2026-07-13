// @vitest-environment jsdom
/**
 * Scenario: projected assistant blocks and tool calls become visible chat DOM.
 * Responsibilities: keep plan reviews standalone and make durable plan bodies reviewable.
 * Wiring: real wire mapper, turn projector, ToolCall registry, and PlanReviewTool;
 * markstream-vue workers/rendering are stubbed at the third-party boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-web test -- chat-turn-rendering.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import type { ChatTurn, ToolCall, TurnBlock } from '../src/types';
import type { WireApprovalResponse, WireMessage } from '../src/api/daemon/wire';
import { toAppMessage } from '../src/api/daemon/mappers';
import { messagesToTurns } from '../src/composables/messagesToTurns';
import {
  assistantRenderBlocks,
  formatDuration,
  formatTokens,
  rendersToolCard,
  renderBlockKey,
  toolStackPosition,
  turnBlocks,
  turnFinalText,
  turnToMarkdown,
} from '../src/components/chatTurnRendering';
import ToolCallView from '../src/components/chat/ToolCall.vue';
import approvalEn from '../src/i18n/locales/en/approval';

vi.mock('markstream-vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    MarkdownRender: defineComponent({
      props: { content: { type: String, default: '' } },
      setup(props) {
        return () => h('div', { class: 'markdown-renderer-test' }, props.content);
      },
    }),
    enableKatex: () => {},
    enableMermaid: () => {},
    setKaTeXWorker: () => {},
    clearKaTeXWorker: () => {},
    setMermaidWorker: () => {},
    clearMermaidWorker: () => {},
  };
});

vi.mock('markstream-vue/workers/katexRenderer.worker?worker&type=module', () => ({
  default: class TestKaTeXWorker {},
}));

vi.mock('markstream-vue/workers/mermaidParser.worker?worker&type=module', () => ({
  default: class TestMermaidWorker {},
}));

// The icon registry's virtual `?raw` modules are a Vite build boundary, not
// part of this DOM contract. Keep ToolCall/registry/PlanReviewTool real while
// replacing only that external virtual-module boundary.
vi.mock('../src/lib/icons', () => ({
  SIZE_PX: { sm: 14, md: 16, lg: 20 },
  getIcon: () => undefined,
  iconSvg: () => '',
}));

const mountCleanups: Array<() => void> = [];
const originalMatchMedia = window.matchMedia;

beforeAll(() => {
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

afterEach(() => {
  while (mountCleanups.length > 0) mountCleanups.pop()?.();
});

function tool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'read', arg: `· ${id}.ts`, status: 'ok', ...over };
}

function toolBlock(id: string, over: Partial<ToolCall> = {}): Extract<TurnBlock, { kind: 'tool' }> {
  return { kind: 'tool', tool: tool(id, over) };
}

function assistantTurn(blocks: TurnBlock[], over: Partial<ChatTurn> = {}): ChatTurn {
  return { id: 't1', role: 'assistant', no: 1, text: '', blocks, ...over };
}

const PLAN_DISPLAY = {
  kind: 'plan_review',
  plan: '## Visible release plan\n\nKeep this body in conversation history.',
  path: '/workspace/plans/visible.md',
  options: [{ label: 'Safe rollout', description: 'Use the existing boundary.' }],
};

function replayedPlanTool(approvalResult: WireApprovalResponse, isError: boolean): ToolCall {
  const wireMessages: WireMessage[] = [
    {
      id: 'assistant-plan',
      session_id: 'session-1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          tool_call_id: 'plan-call',
          tool_name: 'ExitPlanMode',
          input: {},
          tool_input_display: PLAN_DISPLAY,
          approval_result: approvalResult,
        },
      ],
      created_at: '2026-01-01T00:00:00.000Z',
      prompt_id: 'prompt-1',
    },
    {
      id: 'tool-plan',
      session_id: 'session-1',
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          tool_call_id: 'plan-call',
          output: isError ? 'Plan rejected.' : 'Plan saved.',
          is_error: isError,
        },
      ],
      created_at: '2026-01-01T00:00:01.000Z',
      prompt_id: 'prompt-1',
    },
  ];
  const turns = messagesToTurns(wireMessages.map(toAppMessage), [], undefined, false);
  const projected = turns[0]?.tools?.[0];
  if (projected === undefined) throw new Error('expected replayed plan tool');
  return projected;
}

function mountToolCall(toolCall: ToolCall): { host: HTMLElement; dispose: () => void } {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(ToolCallView, { tool: toolCall });
  app.provide('resolveImage', async (src: string) => src);
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { approval: approvalEn } },
    }),
  );
  app.mount(host);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    app.unmount();
    host.remove();
  };
  mountCleanups.push(dispose);
  return { host, dispose };
}

async function settleAsyncComponents(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function renderedPlanBody(host: HTMLElement): Promise<HTMLElement> {
  let body: HTMLElement | null = null;
  await vi.waitFor(() => {
    body = host.querySelector<HTMLElement>('.markdown-renderer-test');
    if (body === null) throw new Error('expected rendered plan markdown body');
  });
  return body;
}

describe('formatTokens', () => {
  it('keeps small counts verbatim and abbreviates at the k / M thresholds', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('formatDuration', () => {
  it('switches units at the 1s and 1m boundaries', () => {
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(59_999)).toBe('60.0s');
    expect(formatDuration(60_000)).toBe('1m0.0s');
    expect(formatDuration(90_500)).toBe('1m30.5s');
  });
});

describe('turnBlocks', () => {
  it('returns the ordered blocks as-is when present', () => {
    const blocks: TurnBlock[] = [{ kind: 'text', text: 'hi' }];
    expect(turnBlocks(assistantTurn(blocks))).toBe(blocks);
  });

  it('falls back to thinking -> text -> tools order when blocks are absent', () => {
    const turn: ChatTurn = {
      id: 't1',
      role: 'assistant',
      no: 1,
      text: 'answer',
      thinking: 'plan',
      tools: [tool('a')],
    };
    expect(turnBlocks(turn)).toEqual([
      { kind: 'thinking', thinking: 'plan' },
      { kind: 'text', text: 'answer' },
      { kind: 'tool', tool: tool('a') },
    ]);
  });
});

describe('rendersToolCard', () => {
  it('hides the card only for a successful tool that carries inline media', () => {
    expect(rendersToolCard(toolBlock('a'))).toBe(true);
    expect(rendersToolCard(toolBlock('r', { status: 'running' }))).toBe(true);
    expect(
      rendersToolCard(toolBlock('m', { status: 'ok', media: { kind: 'image', url: 'x' } })),
    ).toBe(false);
    // media but errored -> still rendered as a card
    expect(
      rendersToolCard(toolBlock('e', { status: 'error', media: { kind: 'image', url: 'x' } })),
    ).toBe(true);
  });
});

describe('toolStackPosition', () => {
  it('marks a lone tool single and otherwise reports first/middle/last', () => {
    expect(toolStackPosition(0, 1)).toBe('single');
    expect(toolStackPosition(0, 0)).toBe('single');
    expect(toolStackPosition(0, 3)).toBe('first');
    expect(toolStackPosition(1, 3)).toBe('middle');
    expect(toolStackPosition(2, 3)).toBe('last');
  });
});

describe('assistantRenderBlocks', () => {
  it('groups consecutive renderable tools into one tool-stack', () => {
    const rendered = assistantRenderBlocks(assistantTurn([toolBlock('a'), toolBlock('b')]));
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ kind: 'tool-stack' });
    if (rendered[0]?.kind === 'tool-stack') {
      expect(rendered[0].tools.map((t) => t.tool.id)).toEqual(['a', 'b']);
      expect(rendered[0].tools.map((t) => t.sourceIndex)).toEqual([0, 1]);
    }
  });

  it('renders a lone tool as a standalone tool, not a stack', () => {
    const rendered = assistantRenderBlocks(assistantTurn([toolBlock('a')]));
    expect(rendered).toEqual([{ kind: 'tool', tool: tool('a'), sourceIndex: 0 }]);
  });

  it('breaks the stack when a non-tool block interrupts the run', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('a'), { kind: 'text', text: 'x' }, toolBlock('b')]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['tool', 'text', 'tool']);
  });

  it('breaks the stack when a media tool (no card) interrupts the run', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([
        toolBlock('a'),
        toolBlock('b'),
        toolBlock('c', { status: 'ok', media: { kind: 'image', url: 'x' } }),
      ]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['tool-stack', 'tool']);
    if (rendered[0]?.kind === 'tool-stack') {
      expect(rendered[0].tools.map((t) => t.tool.id)).toEqual(['a', 'b']);
    }
  });

  it('preserves thinking/text order with their source indexes', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([
        { kind: 'thinking', thinking: 'plan' },
        { kind: 'text', text: 'answer' },
      ]),
    );
    expect(rendered).toEqual([
      { kind: 'thinking', thinking: 'plan', sourceIndex: 0 },
      { kind: 'text', text: 'answer', sourceIndex: 1 },
    ]);
  });

  it('keeps a plan review standalone when ordinary tools surround it', () => {
    const plan = toolBlock('plan', {
      name: 'ExitPlanMode',
      planReview: {
        status: 'pending',
        plan: '## Standalone plan',
      },
    });

    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('before'), plan, toolBlock('after')]),
    );

    expect(rendered.map((block) => block.kind)).toEqual(['tool', 'tool', 'tool']);
    expect(rendered[1]).toMatchObject({
      kind: 'tool',
      tool: { id: 'plan', planReview: { plan: '## Standalone plan' } },
    });
  });
});

describe('ToolCall plan review rendering (real component entry)', () => {
  it('keeps rejected replay body visible after replacing a synthetic pending card', async () => {
    const pending = mountToolCall({
      id: 'plan-review-approval-live',
      name: 'ExitPlanMode',
      arg: '',
      status: 'running',
      planReview: {
        status: 'pending',
        plan: '## Visible release plan\n\nKeep this body in conversation history.',
      },
    });
    await settleAsyncComponents();
    expect((await renderedPlanBody(pending.host)).textContent).toContain(
      'Keep this body in conversation history.',
    );

    // Live overlay replacement is a fresh turn/component mount, not a prop
    // update. Recreate that boundary explicitly.
    pending.dispose();
    const rejected = mountToolCall(
      replayedPlanTool(
        { decision: 'rejected', selected_label: 'Reject and Exit' },
        true,
      ),
    );
    await settleAsyncComponents();

    expect(rejected.host.textContent).toContain('Rejected');
    expect(rejected.host.textContent).not.toContain('Selected approach');
    expect((await renderedPlanBody(rejected.host)).textContent).toContain(
      'Keep this body in conversation history.',
    );
  });

  it('shows revision feedback without presenting Revise as a selected approach', async () => {
    const revision = mountToolCall(
      replayedPlanTool(
        {
          decision: 'rejected',
          selected_label: 'Revise',
          feedback: 'Add rollback verification.',
        },
        false,
      ),
    );
    await settleAsyncComponents();

    expect(revision.host.textContent).toContain('Revision requested');
    expect(revision.host.textContent).toContain('Add rollback verification.');
    expect(revision.host.textContent).not.toContain('Selected approach');
  });

  it('reveals approved replay body when the user expands its low-noise history card', async () => {
    const approved = mountToolCall(
      replayedPlanTool(
        { decision: 'approved', selected_label: 'Safe rollout' },
        false,
      ),
    );

    expect(approved.host.textContent).toContain('Approved');
    expect(approved.host.querySelector('.markdown-renderer-test')).toBeNull();
    const expand = approved.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand plan"]',
    );
    if (expand === null) throw new Error('expected plan expand control');
    expand.click();
    await settleAsyncComponents();

    expect((await renderedPlanBody(approved.host)).textContent).toContain(
      'Keep this body in conversation history.',
    );
    expect(approved.host.textContent).toContain('Safe rollout');
  });

});

describe('turnFinalText', () => {
  it('joins only the text blocks, dropping thinking and tools', () => {
    const turn = assistantTurn([
      { kind: 'thinking', thinking: 'plan' },
      { kind: 'text', text: 'first' },
      toolBlock('a'),
      { kind: 'text', text: 'second' },
    ]);
    expect(turnFinalText(turn)).toBe('first\n\nsecond');
  });
});

describe('turnToMarkdown', () => {
  it('renders thinking as a quote, text verbatim, and tool output as a fenced block', () => {
    const turn = assistantTurn([
      { kind: 'thinking', thinking: 'line1\nline2' },
      { kind: 'text', text: 'hello' },
      toolBlock('a', { name: 'bash', output: ['out1', 'out2'] }),
    ]);
    expect(turnToMarkdown(turn)).toBe(
      ['> **Thinking**\n> line1\n> line2', 'hello', '```\n[bash]\nout1\nout2\n```'].join('\n\n'),
    );
  });
});

describe('renderBlockKey', () => {
  it('derives stable keys per block kind', () => {
    expect(renderBlockKey({ kind: 'text', text: 'x', sourceIndex: 2 }, 0)).toBe('text-2');
    expect(renderBlockKey({ kind: 'tool', tool: tool('a'), sourceIndex: 3 }, 0)).toBe('a');
    expect(
      renderBlockKey({ kind: 'tool-stack', tools: [{ tool: tool('a'), sourceIndex: 5 }] }, 0),
    ).toBe('tool-stack-5');
  });
});
