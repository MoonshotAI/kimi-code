// packages/app-core/src/lib/activitySummary.ts
// Smart summary sentence for a folded activity run (see ActivityRun.vue and
// the `activity-run` block in chatTurnRendering.ts). Pure string building with
// an injected translator — no Vue reactivity here; the component recomputes
// when its items change.
//
// Settled shape: one clause per tool kind in first-appearance order, reusing
// the group caption's done-tense templates ("读取了 2 个文件 · 运行了 5 条命令"),
// a failure clause hanging on its kind ("（1 失败）", danger), then the total
// span (faint). Thinking items fold into the run but are not narrated. Live
// shape: the current action ("正在读取 foo.ts") + cumulative done clauses per
// settled kind.
//
// The UI colours fragments by `tone`; `plain` joins everything into one flat
// string for the row's title tooltip.

import type { Translator } from '../contracts';
import { formatDuration } from './formatDuration';
import { normalizeToolName } from './normalizeToolName';
import { toolSummary } from './toolText';

export interface ActivitySummaryTool {
  name: string;
  arg: string;
  status: 'ok' | 'running' | 'error';
}

export type ActivitySummaryItem = { kind: 'thinking' } | { kind: 'tool'; tool: ActivitySummaryTool };

export type SummaryTone = 'normal' | 'danger' | 'faint';

export interface SummaryFragment {
  text: string;
  tone: SummaryTone;
}

/** One ` · `-separated piece of the sentence; fragments concatenate inside it
    (a failure clause rides on its kind clause without a separator). */
export interface SummaryClause {
  fragments: SummaryFragment[];
}

export interface ActivitySummary {
  clauses: SummaryClause[];
  /** Flat full text for the title tooltip (no tone information). */
  plain: string;
  hasError: boolean;
}

export interface LiveSummary {
  /** The current action clause, or null when nothing is actively running. */
  current: SummaryClause | null;
  /** Cumulative done-tense clauses for the other items (faint). */
  done: SummaryClause[];
  plain: string;
}

// Kinds with a typed done-tense template under tools.group.typed (multi_edit
// narrates as edit). Unrecognized kinds — skills, MCP tools, anything without
// a template — fall back to the generic tool-call counter.
const TYPED_KINDS = new Set(['read', 'bash', 'grep', 'search', 'glob', 'ls', 'web_fetch', 'edit', 'write']);

/** The summary's kind identity: multi_edit narrates as edit. */
function clauseKind(name: string): string {
  const kind = normalizeToolName(name);
  return kind === 'multi_edit' ? 'edit' : kind;
}

interface KindAcc {
  count: number;
  errors: number;
}

/** Per-kind counts and failure counts in first-appearance order. */
function aggregate(items: ActivitySummaryItem[]): { order: string[]; byKind: Map<string, KindAcc> } {
  const order: string[] = [];
  const byKind = new Map<string, KindAcc>();
  for (const item of items) {
    if (item.kind === 'thinking') continue;
    const kind = clauseKind(item.tool.name);
    let acc = byKind.get(kind);
    if (!acc) {
      acc = { count: 0, errors: 0 };
      byKind.set(kind, acc);
      order.push(kind);
    }
    acc.count++;
    if (item.tool.status === 'error') acc.errors++;
  }
  return { order, byKind };
}

function doneClauseText(t: Translator, kind: string, count: number): string {
  if (TYPED_KINDS.has(kind)) return t(`tools.group.typed.${kind}.done`, { count });
  return t('tools.group.countOther', { count });
}

function failedFragment(t: Translator, count: number): SummaryFragment {
  return { text: t('tools.activity.failedClause', { count }), tone: 'danger' };
}

function plainText(clauses: SummaryClause[]): string {
  return clauses.map((c) => c.fragments.map((f) => f.text).join('')).join(' · ');
}

/** Settled sentence: typed done clauses (failures attached, danger) +
    optional total span (faint, formatDuration). Thinking items fold into the
    run but are deliberately NOT narrated in the summary — the count is noise
    next to the tool clauses. */
export function summarizeActivity(
  t: Translator,
  items: ActivitySummaryItem[],
  opts: { durationMs?: number } = {},
): ActivitySummary {
  const { order, byKind } = aggregate(items);
  const clauses: SummaryClause[] = [];
  let hasError = false;
  for (const kind of order) {
    const acc = byKind.get(kind);
    if (!acc) continue;
    const fragments: SummaryFragment[] = [{ text: doneClauseText(t, kind, acc.count), tone: 'normal' }];
    if (acc.errors > 0) {
      hasError = true;
      fragments.push(failedFragment(t, acc.errors));
    }
    clauses.push({ fragments });
  }
  if (opts.durationMs !== undefined) {
    const span = formatDuration(opts.durationMs);
    if (span) clauses.push({ fragments: [{ text: span, tone: 'faint' }] });
  }
  return { clauses, plain: plainText(clauses), hasError };
}

/** The current action as a clause: "正在读取 foo.ts" (subject from the tool's
    own argument summary), thinking reuses the thinking row's streaming label,
    and anything unexpected degrades to a generic busy note. */
function currentClause(t: Translator, current: ActivitySummaryItem): SummaryClause {
  if (current.kind === 'thinking') {
    return { fragments: [{ text: t('thinking.streaming'), tone: 'normal' }] };
  }
  const kind = clauseKind(current.tool.name);
  let subject = toolSummary(t, current.tool.name, current.tool.arg);
  // toolSummary's write branch tags the settled-row "created" chip onto the
  // path; a live write hasn't created anything yet — drop the chip.
  if (kind === 'write' && subject) {
    const chip = t('tools.chip.created');
    if (subject.endsWith(chip)) subject = subject.slice(0, subject.length - chip.length).trimEnd();
  }
  const text =
    subject && TYPED_KINDS.has(kind) ? t(`tools.activity.doing.${kind}`, { subject }) : t('tools.activity.busy');
  return { fragments: [{ text, tone: 'normal' }] };
}

/** Live sentence: the current action first, then cumulative done-tense
    clauses over the SETTLED items (the "已读取 2 个文件" prefix rides the
    liveDonePrefix key; empty in English). Anything still running is excluded
    from the stats — an in-flight call isn't "done" even when it isn't the
    current one (parallel tool uses in one message). Elapsed time is NOT
    handled here — the component owns the ticking clock and appends it as its
    own clause. */
export function summarizeLive(
  t: Translator,
  items: ActivitySummaryItem[],
  current: ActivitySummaryItem | null,
): LiveSummary {
  const rest = items.filter(
    (item) => item !== current && !(item.kind === 'tool' && item.tool.status === 'running'),
  );
  const { order, byKind } = aggregate(rest);
  const prefix = t('tools.activity.liveDonePrefix');
  const done: SummaryClause[] = [];
  for (const kind of order) {
    const acc = byKind.get(kind);
    if (!acc) continue;
    const fragments: SummaryFragment[] = [{ text: `${prefix}${doneClauseText(t, kind, acc.count)}`, tone: 'faint' }];
    if (acc.errors > 0) fragments.push(failedFragment(t, acc.errors));
    done.push({ fragments });
  }
  const currentC = current === null ? null : currentClause(t, current);
  const all = currentC ? [currentC, ...done] : done;
  return { current: currentC, done, plain: plainText(all) };
}
