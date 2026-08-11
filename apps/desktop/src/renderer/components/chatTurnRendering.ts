// apps/web/src/components/chatTurnRendering.ts
// Pure turn-rendering helpers: pure functions of their arguments (no Vue
// reactivity, no component state). Shared by ChatPane.vue's template and its
// stateful copy/edit helpers.
import type { ChatTurn, DiffViewLine, TaskNotification, TurnBlock } from '../types';
import { diffStats } from '@moonshot-ai/app-core/client';
import { buildEditDiffLines, toolFilePath } from '@moonshot-ai/app-core/client';
import { normalizeToolName } from '../lib/toolMeta';

// Shared 1024-based token formatter (lib/formatTokens); re-exported so the
// existing ChatPane import keeps working.
export { formatTokens, formatDuration } from '@moonshot-ai/app-core/lib';

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

/** One file touched by the turn's Edit/MultiEdit/Write calls, aggregated across
    every call that named it (a file edited three times appears once). */
export interface TurnFileChange {
  path: string;
  added: number;
  removed: number;
  /** At least one Write named the file. */
  hasWrite: boolean;
  /** At least one edit's stats could not be derived from its args
      (replace_all, args beyond the diff budget, unparseable arg) — or it was
      a Write, whose removed lines are unknowable (new file vs overwrite).
      The totals are then a lower bound, not the full count. */
  statsIncomplete: boolean;
  /** The turn's line diff for this file (the same LCS the stats derive from),
      segments joined in call order; null when underivable (Write / incomplete). */
  diff: DiffViewLine[] | null;
}

/** The turn's file modifications, derived from its Edit/MultiEdit/Write tool
    calls (the daemon carries no per-turn diff stats). Counts what the agent
    declared through those tools — independent of git, so user edits in
    between do not distort it. Errored calls are skipped: their diff describes
    what was attempted, not what happened. Order follows first mention. */
export function turnFileChanges(turn: ChatTurn): TurnFileChange[] {
  const byPath = new Map<string, TurnFileChange>();
  for (const block of turnBlocks(turn)) {
    if (block.kind !== 'tool' || block.tool.status === 'error') continue;
    const tool = block.tool;
    const kind = normalizeToolName(tool.name);
    if (kind !== 'edit' && kind !== 'multi_edit' && kind !== 'write') continue;

    let path: string | undefined;
    let added = 0;
    let removed = 0;
    let hasWrite = false;
    let statsIncomplete = false;
    let diff: DiffViewLine[] | null = null;
    if (kind === 'write') {
      // A Write carries only the final content, so the client cannot tell a
      // new file from an overwrite — the removed lines are unknowable. Report
      // it as incomplete rather than an exact +N −0 that would dress an
      // overwrite up as a pure addition.
      path = toolFilePath(tool);
      hasWrite = true;
      statsIncomplete = true;
    } else {
      diff = buildEditDiffLines(tool);
      path = toolFilePath(tool);
      if (diff) {
        const stats = diffStats(diff);
        added = stats.added;
        removed = stats.removed;
      } else {
        statsIncomplete = true;
      }
    }
    if (!path) continue;

    // Aggregate equivalent spellings of the same file: normalize separators
    // and `.` segments for the map key ("src/a.ts" ≡ "./src/a.ts" ≡
    // "src//a.ts"), while keeping the first-seen spelling for display.
    const key = normalizePathKey(path);
    const entry = byPath.get(key);
    if (entry) {
      entry.added += added;
      entry.removed += removed;
      entry.hasWrite ||= hasWrite;
      entry.statsIncomplete ||= statsIncomplete;
      // Join this call's diff segment onto the file's, hunk-separated; once any
      // call is underivable the whole file's diff is unknowable (null). The
      // incoming segment's line numbers restart at 1, so offset them past the
      // numbers already joined — the highlighter maps tokens by these numbers
      // and a duplicate would paint the earlier hunk with the later one's
      // tokens.
      if (entry.diff !== null && diff !== null) {
        let oldBase = 0;
        let newBase = 0;
        for (const l of entry.diff) {
          if (l.oldNo !== undefined && l.oldNo > oldBase) oldBase = l.oldNo;
          if (l.newNo !== undefined && l.newNo > newBase) newBase = l.newNo;
        }
        const shifted = diff.map((l) => ({
          ...l,
          oldNo: l.oldNo !== undefined ? l.oldNo + oldBase : undefined,
          newNo: l.newNo !== undefined ? l.newNo + newBase : undefined,
        }));
        entry.diff = [...entry.diff, { type: 'hunk', text: '···' }, ...shifted];
      } else {
        entry.diff = null;
      }
    } else {
      byPath.set(key, { path, added, removed, hasWrite, statsIncomplete, diff });
    }
  }
  return [...byPath.values()];
}

// Unify separators and resolve `.` segments so equivalent path spellings map
// to one key. A turn's tools almost always spell one file one way; this stops
// the obvious splits without needing the cwd:
//   - the path KIND's root is kept as an anchor, so "/tmp/a.ts" ≠ "tmp/a.ts";
//   - a Windows drive ("C:") or UNC share ("//server/share") is never popped
//     and folds case, since Windows paths are case-insensitive (POSIX stays
//     case-sensitive);
//   - a ".." that can't cancel a normal segment is kept on a relative path and
//     dropped at an absolute root.
export function normalizePathKey(path: string): string {
  const norm = path.replace(/\\/g, '/');
  // Peel the root anchor: UNC share, a Windows drive, or a POSIX root. These
  // stay out of the segment stack so a ".." can never pop them.
  let root = '';
  let rest = norm;
  let windows = false;
  const unc = /^\/\/([^/]+\/[^/]+)(\/|$)/.exec(norm);
  if (unc) {
    // Keep the trailing slash so root+body re-joins with a separator (else
    // "//server/share/dir" would collapse into "//server/sharedir").
    root = `//${unc[1]!.toLowerCase()}/`;
    rest = norm.slice(unc[0].length - (unc[0].endsWith('/') ? 1 : 0));
    windows = true;
  } else if (/^[a-zA-Z]:\//.test(norm)) {
    root = `${norm[0]!.toLowerCase()}:/`;
    rest = norm.slice(3);
    windows = true;
  } else if (norm.startsWith('/')) {
    root = '/';
    rest = norm.slice(1);
  }
  const isAbs = root !== '';

  const out: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      // Pop a normal segment only; keep a leading ".." on a relative path.
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push(part);
      continue;
    }
    out.push(part);
  }
  const body = out.join('/');
  const key = root + body;
  return windows ? key.toLowerCase() : key;
}

// turnFileChanges synthesizes an LCS diff per Edit, and the turns array is
// rebuilt (fresh objects) on every streamed event — so memoize per turn, keyed
// by an O(1) signature of the tool inputs the stats derive from (NOT the raw
// args, which can hold whole file contents). The cap is a backstop far above
// any real session's turn count, so eviction never thrashes the current scan.
const TURN_FILE_CHANGES_CACHE_CAP = 2000;
const turnFileChangesCache = new Map<string, { key: string; changes: TurnFileChange[] }>();

function turnFileChangesKey(turn: ChatTurn): string {
  const parts: string[] = [];
  for (const block of turnBlocks(turn)) {
    if (block.kind !== 'tool') continue;
    const tool = block.tool;
    const kind = normalizeToolName(tool.name);
    if (kind !== 'edit' && kind !== 'multi_edit' && kind !== 'write') continue;
    parts.push(`${tool.id}:${tool.status}:${tool.arg.length}`);
  }
  return parts.join('|');
}

/** turnFileChanges memoized across turns-array rebuilds (see the cache note). */
export function turnFileChangesCached(turn: ChatTurn): TurnFileChange[] {
  const key = turnFileChangesKey(turn);
  const hit = turnFileChangesCache.get(turn.id);
  if (hit && hit.key === key) return hit.changes;
  const changes = turnFileChanges(turn);
  turnFileChangesCache.set(turn.id, { key, changes });
  if (turnFileChangesCache.size > TURN_FILE_CHANGES_CACHE_CAP) {
    const oldest = turnFileChangesCache.keys().next().value;
    if (oldest !== undefined) turnFileChangesCache.delete(oldest);
  }
  return changes;
}
