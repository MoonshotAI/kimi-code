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

/** One item inside a folded activity run: a thinking segment or a quiet-line
    tool call, keeping its position in the turn's block list. */
export type ActivityItem =
  | { kind: 'thinking'; thinking: string; startedAt?: string; durationMs?: number; sourceIndex: number }
  | { kind: 'tool'; tool: ToolStackItem['tool']; sourceIndex: number };

export type AssistantRenderBlock =
  | { kind: 'thinking'; thinking: string; startedAt?: string; durationMs?: number; sourceIndex: number }
  | { kind: 'text'; text: string; sourceIndex: number }
  | { kind: 'tool'; tool: ToolStackItem['tool']; sourceIndex: number }
  | { kind: 'activity-run'; items: ActivityItem[] };

export function rendersToolCard(block: Extract<TurnBlock, { kind: 'tool' }>): boolean {
  return !(block.tool.status === 'ok' && block.tool.media);
}

// Folding rule: a run of CONSECUTIVE quiet activity (thinking segments +
// quiet-line tool calls) folds into a single disclosure row with a smart
// summary sentence (see lib/activitySummary.ts). Runs need not be homogeneous
// — kinds mix freely inside one run. Text never folds (it breaks the run, as
// does any block that keeps its own richer rendering): result/interaction
// tools stay standalone — todos and goals narrate progress, a sub-agent
// delegation keeps its own identity card, question and swarm are cards,
// successful media tools render inline media, and unrecognized kinds stay
// standalone out of caution. Edits and writes DO fold (their count surfaces
// in the summary sentence).
const FOLDABLE_KINDS = new Set([
  'read',
  'grep',
  'search',
  'glob',
  'ls',
  'web_fetch',
  'bash',
  'edit',
  'multi_edit',
  'write',
]);

/** True when the tool block joins an activity run; false when it renders
    standalone and breaks the run on either side (media without a card, or a
    non-foldable kind). */
function foldsIntoActivityRun(block: Extract<TurnBlock, { kind: 'tool' }>): boolean {
  if (!rendersToolCard(block)) return false;
  return FOLDABLE_KINDS.has(normalizeToolName(block.tool.name));
}

export function assistantRenderBlocks(turn: ChatTurn): AssistantRenderBlock[] {
  const blocks = turnBlocks(turn);
  const rendered: AssistantRenderBlock[] = [];
  let run: ActivityItem[] = [];

  // A run of one item carries no summary value over the plain quiet line —
  // emit it as the standalone thinking / tool block it always was.
  const flushRun = () => {
    const [only] = run;
    if (run.length === 1 && only) {
      rendered.push(only);
    } else if (run.length > 1) {
      rendered.push({ kind: 'activity-run', items: run });
    }
    run = [];
  };

  blocks.forEach((block, sourceIndex) => {
    if (block.kind === 'thinking') {
      run.push({
        kind: 'thinking',
        thinking: block.thinking,
        startedAt: block.startedAt,
        durationMs: block.durationMs,
        sourceIndex,
      });
      return;
    }
    if (block.kind === 'tool' && foldsIntoActivityRun(block)) {
      run.push({ kind: 'tool', tool: block.tool, sourceIndex });
      return;
    }

    flushRun();
    if (block.kind === 'text') {
      rendered.push({ kind: 'text', text: block.text, sourceIndex });
    } else if (block.kind === 'tool') {
      rendered.push({ kind: 'tool', tool: block.tool, sourceIndex });
    }
  });

  flushRun();
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
  if (block.kind === 'activity-run') {
    return `activity-run-${block.items[0]?.sourceIndex ?? index}`;
  }
  if (block.kind === 'tool') return toolStackKey({ tool: block.tool, sourceIndex: block.sourceIndex });
  return `${block.kind}-${block.sourceIndex}`;
}
