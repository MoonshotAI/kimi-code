
export type WaitForStatus = 'completed' | 'timed_out' | 'interrupted' | 'no_tasks';

export interface WaitForResult {
  status: WaitForStatus;
  waitedMs: number;
  timeoutMs?: number;
  taskId?: string;
  finishedStatus?: string;
  finishedDescription?: string;
  outputPreview?: string;
  extraCount: number;
  runningCount: number;
  runningSamples: string[];
  warning?: string;
}

const RUNNING_SAMPLES = 3;

const TRAILING_WAIT_WARNING = /\n\n\[wait_warning\]\n([^\n[][^\n]*)\n?$/;

const EXTRAS_HINT_LINE =
  'Use TaskOutput with one of the task_id values above to read the full output.';

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

function markerOffsets(text: string, name: string, from: number): number[] {
  const re = new RegExp(`^\\[${name}\\]$`, 'gm');
  const offsets: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index >= from) offsets.push(match.index);
  }
  return offsets;
}

function hasBlankLineBefore(text: string, markerOffset: number): boolean {
  return markerOffset >= 2 && text[markerOffset - 1] === '\n' && text[markerOffset - 2] === '\n';
}

function sectionBody(text: string, markerOffset: number, name: string): string {
  const rest = text.slice(markerOffset + name.length + 2);
  const next = /^\[/m.exec(rest);
  return (next === null ? rest : rest.slice(0, next.index)).trim();
}

function isValidExtras(body: string): boolean {
  return body.endsWith(EXTRAS_HINT_LINE);
}

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
  const joined = Array.isArray(output) ? output.join('\n') : output;
  const warning = TRAILING_WAIT_WARNING.exec(joined);
  const text = warning === null ? joined : joined.slice(0, warning.index);

  const firstMarker = /^\[/m.exec(text);
  const header = firstMarker === null ? text : text.slice(0, firstMarker.index);
  const status = field(header, 'wait_status');
  if (status !== 'completed' && status !== 'timed_out' && status !== 'interrupted' && status !== 'no_tasks') {
    return null;
  }

  const waitedMs = Number(field(header, 'waited_ms') ?? 0);
  const timeoutMs = Number(field(header, 'timeout_ms'));

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
  let runningOffset = -1;
  for (const offset of markerOffsets(text, 'still_running', sectionsFrom)) {
    if (extrasOffset >= 0 && offset < extrasOffset) continue;
    if (!hasBlankLineBefore(text, offset)) continue;
    const rest = text.slice(offset + '[still_running]'.length);
    if (/^\[/m.test(rest)) continue;
    const body = rest.trim();
    if (!isValidStillRunning(body)) continue;
    runningCount = countField(body, 'active_background_tasks');
    runningSamples = sampleDescriptions(body, runningCount);
    runningOffset = offset;
  }

  let outputPreview: string | undefined;
  const outputMarker = finished === undefined ? -1 : text.indexOf('\n\n[output]\n', sectionsFrom);
  if (outputMarker >= 0) {
    const ends = [extrasOffset, runningOffset].filter((offset) => offset > outputMarker);
    const body = text.slice(outputMarker + '\n\n[output]\n'.length, ends.length > 0 ? Math.min(...ends) : text.length);
    outputPreview = body.trimEnd() || undefined;
  }

  return {
    status,
    waitedMs: Number.isFinite(waitedMs) ? waitedMs : 0,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    taskId: field(header, 'task_id'),
    finishedStatus: finished === undefined ? undefined : field(finished, 'status'),
    finishedDescription: finished === undefined ? undefined : field(finished, 'description'),
    outputPreview,
    extraCount,
    runningCount,
    runningSamples,
    warning: warning?.[1],
  };
}
