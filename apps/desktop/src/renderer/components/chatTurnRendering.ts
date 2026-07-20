// apps/web/src/components/chatTurnRendering.ts
// Pure turn-rendering helpers: pure functions of their arguments (no Vue
// reactivity, no component state). Shared by ChatPane.vue's template and its
// stateful copy/edit helpers.
import type { ChatTurn, TurnBlock } from '../types';
import { normalizeToolName } from '../lib/toolMeta';

// Shared 1024-based token formatter (lib/formatTokens); re-exported so the
// existing ChatPane import keeps working.
export { formatTokens } from '../lib/formatTokens';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(1);
  return `${m}m${s}s`;
}

// Ordered render blocks for an assistant turn. messagesToTurns supplies `blocks`
// (thinking + text + tool cards in call order); fall back to deriving them from
// the aggregate fields for any turn built without blocks (e.g. unit tests).
export function turnBlocks(turn: ChatTurn): TurnBlock[] {
  if (turn.blocks) return turn.blocks;
  const blocks: TurnBlock[] = [];
  if (turn.thinking) blocks.push({ kind: 'thinking', thinking: turn.thinking });
  if (turn.text) blocks.push({ kind: 'text', text: turn.text });
  for (const tool of turn.tools ?? []) blocks.push({ kind: 'tool', tool });
  return blocks;
}

export type ToolStackItem = {
  tool: Extract<TurnBlock, { kind: 'tool' }>['tool'];
  sourceIndex: number;
};

export type AssistantRenderBlock =
  | { kind: 'thinking'; thinking: string; startedAt?: string; durationMs?: number; sourceIndex: number }
  | { kind: 'text'; text: string; sourceIndex: number }
  | { kind: 'tool'; tool: ToolStackItem['tool']; sourceIndex: number }
  | { kind: 'tool-stack'; tools: ToolStackItem[] };

export function rendersToolCard(block: Extract<TurnBlock, { kind: 'tool' }>): boolean {
  return !(block.tool.status === 'ok' && block.tool.media);
}

// Grouping rule (§04): a tool group is a HOMOGENEOUS batch — consecutive
// calls of ONE groupable kind. Query/execution kinds (read / grep / glob /
// fetch / bash) merge; consequential kinds never do. Edits and writes must
// stay individually visible (the diff stat is the most valuable information
// in the stream), todos and goals narrate progress, a sub-agent delegation
// keeps its own identity card, question and swarm are cards, and
// unrecognized kinds stay standalone out of caution.
const GROUPABLE_KINDS = new Set(['read', 'grep', 'search', 'glob', 'ls', 'web_fetch', 'bash']);

/** The normalized group kind for a tool, or null when the call always
    renders standalone (non-groupable kind, or a media tool without a card). */
function toolGroupKind(tool: ToolStackItem['tool']): string | null {
  if (tool.status === 'ok' && tool.media) return null;
  const kind = normalizeToolName(tool.name);
  return GROUPABLE_KINDS.has(kind) ? kind : null;
}

export function assistantRenderBlocks(turn: ChatTurn): AssistantRenderBlock[] {
  const blocks = turnBlocks(turn);
  const rendered: AssistantRenderBlock[] = [];
  let toolRun: ToolStackItem[] = [];
  let runKind: string | null = null;

  const flushToolRun = () => {
    if (toolRun.length === 1) {
      const [item] = toolRun;
      if (item) rendered.push({ kind: 'tool', tool: item.tool, sourceIndex: item.sourceIndex });
    } else if (toolRun.length > 1) {
      rendered.push({ kind: 'tool-stack', tools: toolRun });
    }
    toolRun = [];
    runKind = null;
  };

  blocks.forEach((block, sourceIndex) => {
    if (block.kind === 'tool') {
      const kind = rendersToolCard(block) ? toolGroupKind(block.tool) : null;
      // Standalone: a media tool (no card) or a non-groupable kind — it
      // breaks any homogeneous run on either side of it.
      if (kind === null) {
        flushToolRun();
        rendered.push({ kind: 'tool', tool: block.tool, sourceIndex });
        return;
      }
      // A different groupable kind breaks the run: groups stay homogeneous.
      if (runKind !== null && kind !== runKind) flushToolRun();
      runKind = kind;
      toolRun.push({ tool: block.tool, sourceIndex });
      return;
    }

    flushToolRun();
    if (block.kind === 'thinking') {
      rendered.push({
        kind: 'thinking',
        thinking: block.thinking,
        startedAt: block.startedAt,
        durationMs: block.durationMs,
        sourceIndex,
      });
    } else if (block.kind === 'text') {
      rendered.push({ kind: 'text', text: block.text, sourceIndex });
    }
  });

  flushToolRun();
  return rendered;
}

export function turnFinalText(turn: ChatTurn): string {
  return turnBlocks(turn)
    .flatMap((blk) => (blk.kind === 'text' && blk.text ? [blk.text] : []))
    .join('\n\n');
}

/** Convert a single turn to Markdown. */
export function turnToMarkdown(turn: ChatTurn): string {
  const parts: string[] = [];
  for (const blk of turnBlocks(turn)) {
    if (blk.kind === 'thinking' && blk.thinking) {
      parts.push(`> **Thinking**\n> ${blk.thinking.split('\n').join('\n> ')}`);
    } else if (blk.kind === 'text' && blk.text) {
      parts.push(blk.text);
    } else if (blk.kind === 'tool' && blk.tool.output && blk.tool.output.length > 0) {
      const output = blk.tool.output.join('\n');
      parts.push(`\`\`\`\n[${blk.tool.name}]\n${output}\n\`\`\``);
    }
  }
  return parts.join('\n\n');
}

export function toolStackKey(item: ToolStackItem): string {
  return item.tool.id || `tool-${item.sourceIndex}`;
}

export function renderBlockKey(block: AssistantRenderBlock, index: number): string {
  if (block.kind === 'tool-stack') {
    return `tool-stack-${block.tools[0]?.sourceIndex ?? index}`;
  }
  if (block.kind === 'tool') return toolStackKey({ tool: block.tool, sourceIndex: block.sourceIndex });
  return `${block.kind}-${block.sourceIndex}`;
}
