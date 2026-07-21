// apps/kimi-web/src/components/chatTurnRendering.ts
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

/** Turn-level fold split (the second folding level above the activity run).
    Once an assistant turn settles, everything BEFORE its final text block
    folds into a single "worked Ns" row; the final text
    — and anything after it, so trailing media / standalone cards stay on
    screen — keeps its normal rendering. A turn with no text block keeps every
    successful-media tool visible from the first one onward for the same
    reason (inline media IS the turn's output); anything else without text
    (e.g. interrupted) folds wholesale, and a text-only turn has nothing to
    fold. */
export interface AssistantFold {
  folded: AssistantRenderBlock[];
  visible: AssistantRenderBlock[];
}

export function splitAssistantFold(turn: ChatTurn): AssistantFold {
  const rendered = assistantRenderBlocks(turn);
  let splitAt = -1;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const block = rendered[i];
    if (block?.kind === 'text' && block.text.trim().length > 0) {
      splitAt = i;
      break;
    }
  }
  if (splitAt === -1) {
    // No text block: the successful-media tools ARE the turn's output, so the
    // split lands before the FIRST one — every media result stays visible,
    // not just the last. Anything else without text (e.g. interrupted) folds
    // wholesale.
    for (let i = 0; i < rendered.length; i++) {
      const block = rendered[i];
      if (block?.kind === 'tool' && !rendersToolCard(block)) {
        splitAt = i;
        break;
      }
    }
    if (splitAt === -1) return { folded: rendered, visible: [] };
  }
  return { folded: rendered.slice(0, splitAt), visible: rendered.slice(splitAt) };
}

/** Earliest thinking-block streaming-open stamp across the turn (renderer-
    measured, live sessions only) — seeds the turn-fold clock so the measured
    span covers the first step too. Undefined for history turns. */
export function turnActivitySeedMs(blocks: TurnBlock[]): number | undefined {
  let best: number | undefined;
  for (const block of blocks) {
    if (block.kind !== 'thinking' || block.startedAt === undefined) continue;
    const ms = Date.parse(block.startedAt);
    if (Number.isNaN(ms)) continue;
    if (best === undefined || ms < best) best = ms;
  }
  return best;
}

/** Parse an ISO timestamp to epoch ms; undefined for missing/invalid input. */
export function isoMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** The turn-fold clock's working state: live while the turn is open (the row
    ticks, parked included), settled once it ends. */
export type TurnWorkState = { phase: 'live'; nowMs: number } | { phase: 'settled' };

/** The turn's ELAPSED span in ms (the fold row's "worked Ns"). While the turn
    is open it ticks from the stamped start — approval/question waits are part
    of the elapsed span by design, so no park bookkeeping exists. Once settled
    it prefers the daemon's own end-to-end durationMs, falls back to the
    server message stamps, and to undefined (generic wording) when nothing is
    stamped. Wall-clock feeds only the live tick; every settled value derives
    from stamps, so throttled tabs, session switches and remounts cannot
    corrupt it. */
export function turnWorkMs(input: {
  startMs?: number;
  endedMs?: number;
  durationMs?: number;
  state: TurnWorkState;
}): number | undefined {
  if (input.state.phase === 'settled') {
    if (input.durationMs !== undefined) return Math.max(0, input.durationMs);
    if (input.startMs === undefined || input.endedMs === undefined) return undefined;
    return Math.max(0, input.endedMs - input.startMs);
  }
  if (input.startMs === undefined) return undefined;
  return Math.max(0, input.state.nowMs - input.startMs);
}

/** Whole-seconds work span, `37s` / `1m37s` — the turn-fold row's vocabulary;
    unlike formatDuration it never shows a decimal fraction. */
export function formatWorkDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function turnFinalText(turn: ChatTurn): string {
  return turnBlocks(turn)
    .flatMap((blk) => (blk.kind === 'text' && blk.text ? [blk.text] : []))
    .join('\n\n');
}

/** The turn's VISIBLE final text — only the text blocks left on screen after
    the turn-level fold. The fold prefix's interim texts are hidden, so the
    final-answer copy must not include them (unlike turnFinalText, which joins
    every text block for full-transcript exports). */
export function turnVisibleFinalText(turn: ChatTurn): string {
  return splitAssistantFold(turn)
    .visible.flatMap((blk) => (blk.kind === 'text' && blk.text ? [blk.text] : []))
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
