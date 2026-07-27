// apps/web/src/components/chatTurnRendering.ts
// Pure turn-rendering helpers: pure functions of their arguments (no Vue
// reactivity, no component state). Shared by ChatPane.vue's template and its
// stateful copy/edit helpers.
import type { ChatTurn, TaskNotification, TurnBlock } from '../types';

// Shared 1024-based token formatter (lib/formatTokens); re-exported so the
// existing ChatPane import keeps working.
export { formatTokens } from '../lib/formatTokens';

/** Whole-second duration, `37s` / `1m37s` / `6m` / `1h4m` — the only
    user-visible duration vocabulary: floored to whole seconds (never a
    decimal fraction), trailing zero units dropped (`6m`, not `6m0s`).
    Sub-second spans return '' — callers hide them ("0s" reads like clutter). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s === 0 ? '' : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return rest === 0 ? `${m}m` : `${m}m${rest}s`;
  }
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}h` : `${h}h${rest}m`;
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

/** One item inside a folded activity run: a thinking segment or a tool
    call, keeping its position in the turn's block list. */
export type ActivityItem =
  | { kind: 'thinking'; thinking: string; startedAt?: string; durationMs?: number; sourceIndex: number }
  | { kind: 'tool'; tool: ToolStackItem['tool']; sourceIndex: number };

export type AssistantRenderBlock =
  | { kind: 'thinking'; thinking: string; startedAt?: string; durationMs?: number; sourceIndex: number }
  | { kind: 'text'; text: string; sourceIndex: number }
  | { kind: 'tool'; tool: ToolStackItem['tool']; sourceIndex: number }
  | { kind: 'activity-run'; items: ActivityItem[] }
  | { kind: 'notification'; items: TaskNotification[]; sourceIndex: number };

export function rendersToolCard(block: Extract<TurnBlock, { kind: 'tool' }>): boolean {
  return !(block.tool.status === 'ok' && block.tool.media);
}

// Folding rule: a run of CONSECUTIVE activity (thinking segments + tool
// calls) folds into a single disclosure row with a smart summary sentence
// (see lib/activitySummary.ts). Runs need not be homogeneous — kinds mix
// freely inside one run, and EVERY tool kind folds: the run body renders
// the same ToolCall the standalone path would, and the row stays expanded
// while the run is live, so interaction / progress cards (question,
// delegation, todos, goals, swarm) stay visible exactly while active. Text
// never folds. Successful media tools render inline media (no card) and
// stay standalone — the media IS the turn's output.
export function assistantRenderBlocks(turn: ChatTurn): AssistantRenderBlock[] {
  const blocks = turnBlocks(turn);
  const rendered: AssistantRenderBlock[] = [];
  let run: ActivityItem[] = [];
  // Consecutive notification blocks merge into ONE render block (a single
  // notification renders as a lone card; ≥2 as a group card). Anything that
  // is not a notification — text included — breaks the grouping.
  let pending: { items: TaskNotification[]; sourceIndex: number } | null = null;

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
  const flushNotifications = () => {
    if (pending) rendered.push({ kind: 'notification', items: pending.items, sourceIndex: pending.sourceIndex });
    pending = null;
  };

  blocks.forEach((block, sourceIndex) => {
    if (block.kind === 'notification') {
      flushRun();
      if (pending) pending.items.push(block.notification);
      else pending = { items: [block.notification], sourceIndex };
      return;
    }
    flushNotifications();
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
    if (block.kind === 'tool' && rendersToolCard(block)) {
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
  flushNotifications();
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
    // not just the last. A notification card gets the same treatment: it is
    // an event worth seeing, not process noise. Anything else without text
    // (e.g. interrupted) folds wholesale.
    for (let i = 0; i < rendered.length; i++) {
      const block = rendered[i];
      if (block?.kind === 'tool' && !rendersToolCard(block)) {
        splitAt = i;
        break;
      }
      if (block?.kind === 'notification') {
        splitAt = i;
        break;
      }
    }
    if (splitAt === -1) return { folded: rendered, visible: [] };
  }
  const folded = rendered.slice(0, splitAt);
  const visible = rendered.slice(splitAt);
  // Notification cards never fold: they are events the user must be able to
  // notice (a completed/failed background task), not process noise — folding
  // them behind "Worked Ns" would defeat the point of rendering them at all.
  // They leave the folded prefix and render right after the fold row, in
  // order.
  const punched = folded.filter((b) => b.kind === 'notification');
  if (punched.length > 0) {
    return {
      folded: folded.filter((b) => b.kind !== 'notification'),
      visible: [...punched, ...visible],
    };
  }
  return { folded, visible };
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
    } else if (blk.kind === 'notification') {
      // A visible card must not vanish from transcript copies: quote its
      // title/type and EVERY body line, mirroring the thinking-block
      // treatment (a naive join would let later body lines escape the quote).
      const n = blk.notification;
      const lines = [n.title, n.type, ...n.body.split('\n')].filter((s) => s !== '');
      if (lines.length > 0) parts.push(`> **Notification**\n> ${lines.join('\n> ')}`);
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
