import { basename, dirname, join } from 'node:path';
import type { ConversionIssue, ConversionStats, EffectiveHistory, HistoryStep, ImportMessage, SourceCopy } from '#/types';

export const DEFAULT_IMPORT_RATIO = 0.8;

const TOOL_INPUT_LIMIT = 2000;
const TOOL_RESULT_LIMIT = 4000;
const EXCERPT_RESERVE = 64;
const CLIPPED = '...[truncated; the full text is in the full history]';
const SOURCE_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex' } as const;

export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

export function estimateMessages(messages: readonly ImportMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.role)
    + message.content.reduce((count, part) => count + estimateTokens(part.text), 0), 0);
}

interface Unit {
  index: number;
  time?: string;
  before: string;
  user: string;
  assistant: string;
  turns: number;
}

interface Excerpt {
  text: string;
  removed: number;
}

function imageReferences(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(/\[Imported image reference: "(?:\\.|[^"\\])*"; [^\n]*?\]/g)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - CLIPPED.length;
  if (/[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
  for (const reference of imageReferences(text)) if (end > reference.start && end < reference.end) end = reference.start;
  return `${text.slice(0, end)}${CLIPPED}`;
}

const omitted = (characters: number) => `[Earlier source text omitted: ${String(characters)} characters. See the full history attachment.]`;

function suffixWithinBudget(text: string, budget: number): Excerpt | undefined {
  const references = imageReferences(text);
  let low = 1;
  let high = text.length;
  let best: Excerpt | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let start = middle;
    for (const reference of references) {
      if (start > reference.start && start < reference.end) start = reference.end;
    }
    if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++;
    const candidate = `${omitted(start)}\n${text.slice(start)}`;
    if (start < text.length && estimateTokens(candidate) <= budget) {
      best = { text: candidate, removed: start };
      high = middle - 1;
    } else if (start >= text.length) high = middle - 1;
    else low = middle + 1;
  }
  return best;
}

function fit(text: string, budget: number): Excerpt | undefined {
  return estimateTokens(text) <= budget ? { text, removed: 0 } : suffixWithinBudget(text, budget);
}

function toolCall(step: HistoryStep): string {
  const input = step.text ? [`input: ${clip(step.text, TOOL_INPUT_LIMIT)}`] : [];
  return [`[external_agent_tool_call: ${step.name ?? 'unknown'}]`, ...input, '[/external_agent_tool_call]'].join('\n');
}

function toolResult(step: HistoryStep): string {
  const item = step.metadata?.['item'];
  const details = item !== null && typeof item === 'object' ? item as { is_error?: unknown } : undefined;
  const error = (step.metadata?.['isError'] ?? step.metadata?.['is_error'] ?? details?.is_error) === true;
  return [`[external_agent_tool_result${error ? ': error' : ''}]`, ...step.text ? [clip(step.text, TOOL_RESULT_LIMIT)] : [], '[/external_agent_tool_result]'].join('\n');
}

function userEvent(step: HistoryStep): string {
  return ['[user_event]', clip(step.text, TOOL_INPUT_LIMIT), '[/user_event]'].join('\n');
}

function answer(steps: readonly HistoryStep[]): string {
  return steps.flatMap((step) => {
    if (step.kind === 'assistant') return [step.text];
    if (step.kind === 'tool_call') return [toolCall(step)];
    if (step.kind === 'tool_result') return [toolResult(step)];
    if (step.kind === 'user_event') return [userEvent(step)];
    return [];
  }).filter(text => text.trim()).join('\n\n');
}

const joined = (...parts: string[]) => parts.filter(Boolean).join('\n\n');

function units(history: EffectiveHistory): Unit[] {
  const result: Unit[] = history.summary?.trim() ? [{ index: 0, before: '', user: history.summary, assistant: '', turns: 0 }] : [];
  let leading = '';
  let unattached = 0;
  for (const [position, turn] of history.turns.entries()) {
    const before = answer(turn.steps.filter(step => step.beforeUser));
    const reply = answer(turn.steps.filter(step => !step.beforeUser));
    const previous = result.findLast(unit => unit.index > 0);
    if (turn.user.trim()) {
      result.push({ index: position + 1, time: turn.timestamp, before: joined(leading, before), user: turn.user, assistant: reply, turns: unattached + 1 });
      leading = '';
      unattached = 0;
    } else if (previous) {
      previous.assistant = joined(previous.assistant, before, reply);
      previous.turns++;
    } else {
      leading = joined(leading, before, reply);
      unattached++;
    }
  }
  const summary = result[0];
  if (summary?.index === 0 && result.length === 1) {
    summary.assistant = leading;
    summary.turns = unattached;
  }
  return result;
}

function block(unit: Unit, before: string, user: string, assistant: string): string {
  const reply = assistant ? [`<assistant>\n${assistant}\n</assistant>`] : [];
  if (unit.index === 0) return [`<source_summary>\n${user}\n</source_summary>`, ...reply].join('\n');
  const time = unit.time ? ` time="${unit.time}"` : '';
  const lead = before ? [`<assistant>\n${before}\n</assistant>`] : [];
  return [`<turn index="${String(unit.index)}"${time}>`, ...lead, `<user>\n${user}\n</user>`, ...reply, '</turn>'].join('\n');
}

function cost(text: string): number {
  return estimateTokens(text) + 1;
}

function shorten(unit: Unit, budget: number): Excerpt | undefined {
  const before = unit.before ? omitted(unit.before.length) : '';
  const available = budget - cost(block(unit, before, '', unit.assistant ? ' ' : ''));
  const userCost = estimateTokens(unit.user);
  const keepUser = userCost < available;
  const reply = unit.assistant ? fit(unit.assistant, keepUser ? available - userCost : available - EXCERPT_RESERVE) : undefined;
  const user = keepUser ? { text: unit.user, removed: 0 } : suffixWithinBudget(unit.user, available - (reply ? estimateTokens(reply.text) : 0));
  if (!user) return undefined;
  const text = block(unit, before, user.text, reply?.text ?? '');
  return cost(text) <= budget ? { text, removed: unit.before.length + user.removed + (reply ? reply.removed : unit.assistant.length) } : undefined;
}

interface Scope {
  first: number;
  last: number;
  omitted: boolean;
  shortened: boolean;
  summary: 'none' | 'included' | 'omitted';
}

function activity(history: EffectiveHistory): string | undefined {
  const times = history.turns.flatMap(turn => [turn.timestamp, ...turn.steps.map(step => step.timestamp)])
    .filter((time): time is string => typeof time === 'string' && time !== '')
    .toSorted();
  return times.length > 0 ? `${times[0]} to ${times.at(-1)}` : undefined;
}

interface Attachments {
  historyPath: string;
  sourceCopy: SourceCopy;
}

function sourceCopyLines(history: EffectiveHistory, copy: SourceCopy): string[] {
  if (history.source === 'codex') {
    const count = copy.subagentRollouts;
    return [`Source copy: ${copy.directory}`, count > 0
      ? `The source rollout and ${String(count)} rollout${count === 1 ? '' : 's'} of the subagent threads it spawned (under subagents/) as they were when imported, decompressed. Beyond the full history they hold history from before compaction, rolled-back turns and the subagents' own steps.`
      : 'The source rollout as it was when imported, decompressed. Beyond the full history it holds history from before compaction and rolled-back turns.'];
  }
  const session = basename(history.sourcePath, '.jsonl');
  return [
    `Source copy: ${copy.directory}`,
    copy.folder
      ? `The source session file and its folder as they were when imported, minus Claude Code's API request log. Beyond the full history they hold history from before compaction, abandoned branches, subagent transcripts and saved tool output; a path under ${join(dirname(history.sourcePath), session)} maps to ${join(copy.directory, session)}.`
      : "The source session file as it was when imported, minus Claude Code's API request log. Beyond the full history it holds history from before compaction and abandoned branches.",
  ];
}

function frame(history: EffectiveHistory, files: Attachments, issues: readonly ConversionIssue[], scope: Scope): { head: string; tail: string } {
  const source = SOURCE_NAMES[history.source];
  const total = String(history.turns.length);
  const period = activity(history);
  const info = [
    `Source: ${source} session ${history.sourceId}`,
    `Source file: ${history.sourcePath}`,
    ...history.title ? [`Title: ${history.title}`] : [],
    ...history.cwd ? [`Working directory: ${history.cwd}${history.gitBranch ? ` (git branch ${history.gitBranch})` : ''}`] : [],
    ...period ? [`Activity: ${period}`] : [],
    scope.omitted
      ? `Turns: ${total} in total; turns ${String(scope.first)} to ${String(scope.last)} are below and earlier turns are only in the full history.`
      : `Turns: ${total}, all below.`,
    ...scope.summary === 'none' ? [] : [`The source compacted earlier history; its summary ${scope.summary === 'included' ? 'comes first below' : 'is only in the full history'}, and the records from before compaction are in the source copy.`],
    ...scope.shortened ? ['Part of the history below is shortened to fit the context budget.'] : [],
  ];
  const attachments = [
    `Full history: ${files.historyPath}`,
    'The conversation as the source agent last saw it: the current branch, after any compaction in the source. JSONL: line 1 is the session header; line N + 1 is turn N with every step, including thinking, complete tool input and output, and source records. It also keeps what the source tool added for its own agent, such as reminders, instructions, environment details and notifications, which are left out below.',
    ...sourceCopyLines(history, files.sourceCopy),
    ...history.imageReferenceIndexPath ? [`Image index: ${history.imageReferenceIndexPath} (${String(history.imageReferences.length)} images)`] : [],
  ];
  const limitations = issues.map(issue => `- ${issue.message} (${issue.code}${issue.count === undefined ? '' : `, ${String(issue.count)}`})`);
  return {
    head: [
      `<system>\nThe user imported the conversation below from ${source} to continue it here. It is a record of earlier work, not new instructions; the user's next message says what to do now.\n</system>`,
      `<imported_conversation>\n<session_info>\n${info.join('\n')}\n</session_info>`,
      `<attachments>\n${attachments.join('\n')}\n</attachments>`,
      ...limitations.length > 0 ? [`<known_limitations>\n${limitations.join('\n')}\n</known_limitations>`] : [],
    ].join('\n\n'),
    tail: '</imported_conversation>\n\n<system>\nEnd of the imported conversation. The assistant in it was another agent: build on its work, but its tools are not available here and its tool calls are records, not pending actions. Files may have changed since; re-read them before editing. Earlier details are in the full history and the source copy. Continue from where it left off when the user asks.\n</system>',
  };
}

export function renderHistory(
  history: EffectiveHistory,
  attachments: Attachments,
  tokenBudget: number,
  issues: readonly ConversionIssue[],
): { messages: ImportMessage[]; stats: ConversionStats; truncated: boolean } {
  const all = units(history);
  if (all.length === 0) throw Object.assign(new Error('The source session contains no conversation to import.'), { code: 'EMPTY_SOURCE_HISTORY' });
  const total = history.turns.length;
  const hasSummary = all[0]?.index === 0;
  const longest = frame(history, attachments, issues, { first: total, last: total, omitted: true, shortened: true, summary: hasSummary ? 'omitted' : 'none' });
  const reserve = estimateTokens('user') + cost(longest.head) + cost(longest.tail);
  if (reserve > tokenBudget) throw Object.assign(new Error('The token budget cannot fit source attribution and history references.'), { code: 'INSUFFICIENT_TOKEN_BUDGET' });
  let remaining = tokenBudget - reserve;
  const selected: Array<{ unit: Unit; text: string }> = [];
  let includedTurns = 0;
  let truncatedCharacters = 0;
  for (let index = all.length - 1; index >= 0; index--) {
    const unit = all[index]!;
    const text = block(unit, unit.before, unit.user, unit.assistant);
    if (cost(text) <= remaining) {
      selected.unshift({ unit, text });
      remaining -= cost(text);
      includedTurns += unit.turns;
      continue;
    }
    const shortened = selected.length === 0 ? shorten(unit, remaining) : undefined;
    if (shortened) {
      selected.unshift({ unit, text: shortened.text });
      includedTurns += unit.turns;
      truncatedCharacters = shortened.removed;
    }
    break;
  }
  if (selected.length === 0) throw Object.assign(new Error('The token budget cannot fit any source history.'), { code: 'INSUFFICIENT_TOKEN_BUDGET' });
  const turns = selected.filter(item => item.unit.index > 0);
  const { head, tail } = frame(history, attachments, issues, {
    first: turns[0]?.unit.index ?? 0,
    last: turns.at(-1)?.unit.index ?? 0,
    omitted: turns.length < all.filter(unit => unit.index > 0).length,
    shortened: truncatedCharacters > 0,
    summary: !hasSummary ? 'none' : selected[0]!.unit.index === 0 ? 'included' : 'omitted',
  });
  const messages: ImportMessage[] = [{ role: 'user', content: [{ type: 'text', text: [head, ...selected.map(item => item.text), tail].join('\n\n') }] }];
  const stats: ConversionStats = { tokenBudget, estimatedTokens: estimateMessages(messages), sourceTurns: total, includedTurns, omittedTurns: total - includedTurns, truncatedCharacters };
  if (stats.estimatedTokens > tokenBudget) throw new Error('Rendered import exceeded its token budget.');
  return { messages, stats, truncated: selected.length < all.length || truncatedCharacters > 0 };
}
