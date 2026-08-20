// packages/app-core/src/lib/parseWaitForResult.ts
// Parse the text timeline returned by the WaitFor tool (waits for background
// tasks). The output is a small header (`wait_status` / `task_id` /
// `waited_ms` / `timeout_ms`) followed by `[finished]` /
// `[completed_during_wait]` / `[still_running]` sections; the WaitFor tool
// card turns it into a structured glance view. A timed-out wait is NOT an
// error (the tool says so itself) — it arrives as a normal result with
// `wait_status: timed_out`. Defensive: never throws; returns null for output
// that is not a WaitFor timeline so the card can fall back to the raw panel.
//
// The finished task's `[output]` preview is ARBITRARY task log text, so
// nothing is read by global first-match: header fields come only from the
// region before the first section marker, and sections are recognized only in
// the producer's fixed order ([finished] + preview, then
// [completed_during_wait], then [still_running]), at producer boundaries
// (blank-line-separated, [still_running] forming the output's tail), and
// validated against the producer's shape (hint line, record count). A
// look-alike marker line inside the preview therefore never becomes a
// section; only a forged tail section byte-identical to a real one remains
// indistinguishable — accepting it is correct, since it IS the legal shape.

export type WaitForStatus = 'completed' | 'timed_out' | 'no_tasks';

export interface WaitForResult {
  status: WaitForStatus;
  waitedMs: number;
  /** Top-level `task_id`: the finished task (completed), or the waited task
   *  when the call targeted one (timed_out). Absent for no_tasks / wait-any. */
  taskId?: string;
  /** Terminal status of the finished task (`completed` / `failed` /
   *  `timed_out` / `killed` / `lost`). */
  finishedStatus?: string;
  finishedDescription?: string;
  /** Other tasks that also reached a terminal state during the wait. */
  extraCount: number;
  runningCount: number;
  /** Up to RUNNING_SAMPLES descriptions from the still-running list. */
  runningSamples: string[];
}

const RUNNING_SAMPLES = 3;

/** Fixed line the producer appends after a [completed_during_wait] list. */
const EXTRAS_HINT_LINE =
  'Use TaskOutput with one of the task_id values above to read the full output.';

/** First `name: value` line of a block (values are single-line by contract). */
function field(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}: (.+)$`, 'm').exec(text);
  return match?.[1];
}

function countField(text: string, name: string): number {
  const value = Number(field(text, name) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function countOccurrences(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Offsets of every line-anchored `[name]` marker in `text` at/after `from`. */
function markerOffsets(text: string, name: string, from: number): number[] {
  const re = new RegExp(`^\\[${name}\\]$`, 'gm');
  const offsets: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index >= from) offsets.push(match.index);
  }
  return offsets;
}

/** The producer always separates its sections with a blank line; a marker
 *  quoted mid-log inside the preview is not. */
function hasBlankLineBefore(text: string, markerOffset: number): boolean {
  return markerOffset >= 2 && text[markerOffset - 1] === '\n' && text[markerOffset - 2] === '\n';
}

/** The trimmed body after a marker line, up to the next `[...]` line or EOF. */
function sectionBody(text: string, markerOffset: number, name: string): string {
  const rest = text.slice(markerOffset + name.length + 2);
  const next = /^\[/m.exec(rest);
  return (next === null ? rest : rest.slice(0, next.index)).trim();
}

/** A real [completed_during_wait] section always ends with the producer's
 *  TaskOutput hint line; a preview look-alike does not. */
function isValidExtras(body: string): boolean {
  return body.endsWith(EXTRAS_HINT_LINE);
}

/** A real [still_running] section is the producer's task list: the
 *  `active_background_tasks` header count equals the number of task records
 *  that follow it. A count line quoted inside the preview fails this check. */
function isValidStillRunning(body: string): boolean {
  const raw = field(body, 'active_background_tasks');
  if (raw === undefined) return false;
  const count = Number(raw);
  if (!Number.isFinite(count)) return false;
  return countOccurrences(body, /^task_id: /gm) === count;
}

function sampleDescriptions(stillRunning: string, runningCount: number): string[] {
  const descriptions = [...stillRunning.matchAll(/^description: (.+)$/gm)].map(
    (match) => match[1] ?? '',
  );
  return descriptions.slice(0, Math.min(RUNNING_SAMPLES, runningCount));
}

export function parseWaitForResult(
  output: string[] | string | undefined | null,
): WaitForResult | null {
  if (output === undefined || output === null) return null;
  const text = Array.isArray(output) ? output.join('\n') : output;

  // The header is everything before the first section marker.
  const firstMarker = /^\[/m.exec(text);
  const header = firstMarker === null ? text : text.slice(0, firstMarker.index);
  const status = field(header, 'wait_status');
  if (status !== 'completed' && status !== 'timed_out' && status !== 'no_tasks') return null;

  const waitedMs = Number(field(header, 'waited_ms') ?? 0);

  // [finished] is the producer's first section (completed only); its body ends
  // at the [output] marker whose preview lines are never parsed as fields.
  let finished: string | undefined;
  let sectionsFrom = firstMarker?.index ?? text.length;
  if (
    status === 'completed' &&
    firstMarker !== null &&
    text.slice(firstMarker.index).startsWith('[finished]')
  ) {
    finished = sectionBody(text, firstMarker.index, 'finished');
    sectionsFrom = firstMarker.index + '[finished]'.length;
  }

  // Real sections come after the whole preview, so the LAST valid candidate
  // wins; legal order requires still_running to follow completed_during_wait.
  let extraCount = 0;
  let extrasOffset = -1;
  for (const offset of markerOffsets(text, 'completed_during_wait', sectionsFrom)) {
    if (!hasBlankLineBefore(text, offset)) continue;
    const body = sectionBody(text, offset, 'completed_during_wait');
    if (!isValidExtras(body)) continue;
    extraCount = countOccurrences(body, /^task_id: /gm);
    extrasOffset = offset;
  }

  let runningCount = 0;
  let runningSamples: string[] = [];
  for (const offset of markerOffsets(text, 'still_running', sectionsFrom)) {
    if (extrasOffset >= 0 && offset < extrasOffset) continue;
    if (!hasBlankLineBefore(text, offset)) continue;
    // A real [still_running] section is the output's tail: no marker-looking
    // line may follow it — a marker quoted inside the preview is always
    // trailed by more preview lines (log lines like `[INFO]` included).
    const rest = text.slice(offset + '[still_running]'.length);
    if (/^\[/m.test(rest)) continue;
    const body = rest.trim();
    if (!isValidStillRunning(body)) continue;
    runningCount = countField(body, 'active_background_tasks');
    runningSamples = sampleDescriptions(body, runningCount);
  }

  return {
    status,
    waitedMs: Number.isFinite(waitedMs) ? waitedMs : 0,
    taskId: field(header, 'task_id'),
    finishedStatus: finished === undefined ? undefined : field(finished, 'status'),
    finishedDescription: finished === undefined ? undefined : field(finished, 'description'),
    extraCount,
    runningCount,
    runningSamples,
  };
}
