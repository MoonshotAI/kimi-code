
import type { Translator } from '../contracts';
import { BROWSER_TOOL_NAME } from './browserToolName';
import { formatDuration } from './formatDuration';
import { normalizeToolName } from './normalizeToolName';
import { activityToolSummary } from './toolText';

export interface ActivitySummaryTool {
  name: string;
  arg: string;
  status: 'ok' | 'running' | 'error' | 'cancelled';
  autoReviewing?: boolean;
  id?: string;
  output?: readonly string[];
}

export type ActivitySummaryItem = { kind: 'thinking' } | { kind: 'tool'; tool: ActivitySummaryTool };

export type SummaryTone = 'normal' | 'faint';

export interface SummaryFragment {
  text: string;
  tone: SummaryTone;
}

export interface SummaryClause {
  fragments: SummaryFragment[];
  title?: string;
}

export interface ActivitySummary {
  clauses: SummaryClause[];
  plain: string;
  hasError: boolean;
  detail?: string;
}

export interface LiveSummary {
  current: SummaryClause | null;
  done: SummaryClause[];
  plain: string;
  detail?: string;
}

export interface ActivityClauseProvider {
  readonly kind: string;
  done(tools: readonly ActivitySummaryTool[], live: boolean): SummaryClause[] | undefined;
  doing?(tool: ActivitySummaryTool, finished: readonly ActivitySummaryTool[]): string | undefined;
  tail?(tools: readonly ActivitySummaryTool[], live: boolean): SummaryClause | undefined;
  detail?(tools: readonly ActivitySummaryTool[]): string | undefined;
}

const OTHER_KIND = 'other';
const TYPED_KINDS = new Set(['read', 'bash', 'grep', 'search', 'glob', 'ls', 'web_fetch', 'edit', 'write', 'browser']);

function clauseKind(name: string): string {
  if (name === BROWSER_TOOL_NAME) return 'browser';
  const kind = normalizeToolName(name);
  return kind === 'multi_edit' ? 'edit' : kind;
}

interface KindAcc {
  count: number;
  errors: number;
  tools: ActivitySummaryTool[];
}

function aggregate(
  items: ActivitySummaryItem[],
  providers: readonly ActivityClauseProvider[],
): { order: string[]; byKind: Map<string, KindAcc> } {
  const order: string[] = [];
  const byKind = new Map<string, KindAcc>();
  for (const item of items) {
    if (item.kind === 'thinking') continue;
    const toolKind = clauseKind(item.tool.name);
    const kind = TYPED_KINDS.has(toolKind) || providerFor(providers, toolKind) ? toolKind : OTHER_KIND;
    let acc = byKind.get(kind);
    if (!acc) {
      acc = { count: 0, errors: 0, tools: [] };
      byKind.set(kind, acc);
      order.push(kind);
    }
    acc.count++;
    acc.tools.push(item.tool);
    if (item.tool.status === 'error') acc.errors++;
  }
  return { order, byKind };
}

function providerFor(providers: readonly ActivityClauseProvider[], kind: string): ActivityClauseProvider | undefined {
  return providers.find((provider) => provider.kind === kind);
}

function detailText(providers: readonly ActivityClauseProvider[], order: string[], byKind: Map<string, KindAcc>): string | undefined {
  const lines = order.flatMap((kind) => {
    const line = providerFor(providers, kind)?.detail?.(byKind.get(kind)?.tools ?? []);
    return line ? [line] : [];
  });
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function doneClauseText(t: Translator, kind: string, count: number): string {
  if (TYPED_KINDS.has(kind)) return t(`tools.group.typed.${kind}.done`, { count });
  return t('tools.group.countOther', { count });
}

function plainText(clauses: SummaryClause[]): string {
  return clauses.map((c) => c.title ?? c.fragments.map((f) => f.text).join('')).join(' · ');
}

function failedFragment(t: Translator, count: number, tone: SummaryTone): SummaryFragment {
  return { text: t('tools.activity.failedClause', { count }), tone };
}

export function summarizeActivity(
  t: Translator,
  items: ActivitySummaryItem[],
  opts: { durationMs?: number; locale?: string; providers?: readonly ActivityClauseProvider[] } = {},
): ActivitySummary {
  const providers = opts.providers ?? [];
  const { order, byKind } = aggregate(items, providers);
  const clauses: SummaryClause[] = [];
  let hasError = false;
  for (const kind of order) {
    const acc = byKind.get(kind);
    if (!acc) continue;
    if (acc.errors > 0) hasError = true;
    const provided = providerFor(providers, kind)?.done(acc.tools, false);
    if (provided) {
      clauses.push(...provided);
      continue;
    }
    const fragments: SummaryFragment[] = [{ text: doneClauseText(t, kind, acc.count), tone: 'normal' }];
    if (acc.errors > 0) fragments.push(failedFragment(t, acc.errors, 'normal'));
    clauses.push({ fragments });
  }
  for (const kind of order) {
    const tail = providerFor(providers, kind)?.tail?.(byKind.get(kind)?.tools ?? [], false);
    if (tail) clauses.push(tail);
  }
  if (opts.durationMs !== undefined) {
    const span = formatDuration(opts.durationMs, opts.locale ?? 'en');
    if (span) clauses.push({ fragments: [{ text: span, tone: 'faint' }] });
  }
  return { clauses, plain: plainText(clauses), hasError, detail: detailText(providers, order, byKind) };
}

function currentClause(
  t: Translator,
  current: ActivitySummaryItem,
  providers: readonly ActivityClauseProvider[],
  finished: Map<string, KindAcc>,
  autoReviewHint: boolean,
): SummaryClause {
  if (current.kind === 'thinking') {
    return { fragments: [{ text: t('thinking.streaming'), tone: 'normal' }] };
  }
  if (autoReviewHint && current.tool.autoReviewing) {
    return { fragments: [{ text: t('tools.activity.autoReviewing'), tone: 'normal' }] };
  }
  const kind = clauseKind(current.tool.name);
  const provided = providerFor(providers, kind)?.doing?.(current.tool, finished.get(kind)?.tools ?? []);
  if (provided) return { fragments: [{ text: provided, tone: 'normal' }] };
  if (kind === 'browser') return { fragments: [{ text: t('tools.activity.doing.browser'), tone: 'normal' }] };
  if (kind === 'bash') return { fragments: [{ text: t('tools.activity.doing.bash'), tone: 'normal' }] };
  const stripCreatedChip = (value: string): string => {
    if (kind !== 'write') return value;
    const chip = t('tools.chip.created');
    return value.endsWith(chip) ? value.slice(0, value.length - chip.length).trimEnd() : value;
  };
  const subject = stripCreatedChip(activityToolSummary(t, current.tool.name, current.tool.arg));
  if (!TYPED_KINDS.has(kind)) return { fragments: [{ text: t('tools.activity.busy'), tone: 'normal' }] };
  if (!subject) return { fragments: [{ text: t(`tools.activity.doingBare.${kind}`), tone: 'normal' }] };
  const titleSubject = stripCreatedChip(activityToolSummary(t, current.tool.name, current.tool.arg, true));
  const text = t(`tools.activity.doing.${kind}`, { subject });
  const title = titleSubject && titleSubject !== subject ? t(`tools.activity.doing.${kind}`, { subject: titleSubject }) : undefined;
  return { fragments: [{ text, tone: 'normal' }], ...(title ? { title } : {}) };
}

export function summarizeLive(
  t: Translator,
  items: ActivitySummaryItem[],
  current: ActivitySummaryItem | null,
  providers: readonly ActivityClauseProvider[] = [],
  autoReviewHint = true,
): LiveSummary {
  const rest = items.filter(
    (item) => item !== current && !(item.kind === 'tool' && item.tool.status === 'running'),
  );
  const { order, byKind } = aggregate(rest, providers);
  const prefix = t('tools.activity.liveDonePrefix');
  const done: SummaryClause[] = [];
  for (const kind of order) {
    const acc = byKind.get(kind);
    if (!acc) continue;
    const provided = providerFor(providers, kind)?.done(acc.tools, true);
    if (provided) {
      done.push(...provided);
      continue;
    }
    const fragments: SummaryFragment[] = [{ text: `${prefix}${doneClauseText(t, kind, acc.count)}`, tone: 'faint' }];
    if (acc.errors > 0) fragments.push(failedFragment(t, acc.errors, 'faint'));
    done.push({ fragments });
  }
  for (const kind of order) {
    const tail = providerFor(providers, kind)?.tail?.(byKind.get(kind)?.tools ?? [], true);
    if (tail) done.push(tail);
  }
  const currentC = current === null ? null : currentClause(t, current, providers, byKind, autoReviewHint);
  const all = currentC ? [currentC, ...done] : done;
  const everything = aggregate(items, providers);
  return { current: currentC, done, plain: plainText(all), detail: detailText(providers, everything.order, everything.byKind) };
}
