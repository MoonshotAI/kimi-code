import type { ReadFileEvent } from '#/app/telemetry/events';
import { estimateTokens } from '#/llm-adapter/contract/tokens';
import type { HostFileStat } from '#/os/interface/hostFileSystem';

import type { ReadInput } from './read';

export interface ReadPageFacts {
  readonly totalLines: number;
  readonly returnedLines: number;
  readonly wholeFile: boolean;
  readonly complete: boolean;
  readonly tokenLimited: boolean;
  readonly lines?: { readonly start: number; readonly end: number };
  readonly next?: { readonly line: number; readonly column: number };
}

export interface ReadObservation {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly file: string;
  readonly name: string;
  readonly args: ReadInput;
  readonly stat: HostFileStat;
  readonly text: string;
  readonly facts: ReadPageFacts;
}

type LineRange = readonly [number, number];

interface FileReadState {
  readonly size: number;
  readonly mtimeMs?: number;
  readonly requests: Set<string>;
  readonly lines: readonly LineRange[];
  readonly next?: { readonly line: number; readonly column: number };
}

const MAX_TRACKED_FILES = 2048;
const MAX_LINE_RANGES = 256;

export class ReadActivity {
  private readonly files = new Map<string, FileReadState>();

  reset(): void {
    this.files.clear();
  }

  observe(observation: ReadObservation): ReadFileEvent {
    const { args, stat, facts } = observation;
    const previous = this.files.get(observation.file);
    const changed = previous !== undefined && (previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs);
    const current = changed ? undefined : previous;
    const request = requestKey(args, facts.totalLines);
    const event: ReadFileEvent = {
      turn_id: observation.turnId,
      tool_call_id: observation.toolCallId,
      ext: fileExtension(observation.name),
      returned_chars: observation.text.length,
      estimated_tokens: estimateTokens(observation.text),
      returned_lines: facts.returnedLines,
      total_lines: facts.totalLines,
      whole_file: facts.wholeFile,
      complete: facts.complete,
      ranged: args.line_offset !== undefined || args.n_lines !== undefined,
      from_tail: (args.line_offset ?? 1) < 0,
      token_limited: facts.tokenLimited,
      requested_max_chars: args.max_chars,
      reread: previous !== undefined,
      reread_unchanged: current?.requests.has(request) ?? false,
      repeated_lines: current === undefined || facts.lines === undefined
        ? 0
        : overlap(current.lines, facts.lines.start, facts.lines.end),
      changed_since_last_read: changed,
      continues_previous_page: previous?.next !== undefined &&
        (args.line_offset ?? 1) === previous.next.line &&
        (args.column_offset ?? 0) === previous.next.column,
    };
    const requests = current?.requests ?? new Set<string>();
    if (facts.complete) requests.add(request);
    const lines = current?.lines ?? [];
    this.files.delete(observation.file);
    if (this.files.size >= MAX_TRACKED_FILES) {
      const oldest = this.files.keys().next();
      if (oldest.done !== true) this.files.delete(oldest.value);
    }
    this.files.set(observation.file, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      requests,
      lines: facts.lines === undefined ? lines : addRange(lines, facts.lines.start, facts.lines.end),
      next: facts.next,
    });
    return event;
  }
}

function requestKey(args: ReadInput, totalLines: number): string {
  const lineOffset = args.line_offset ?? 1;
  const reachesEnd = args.n_lines !== undefined &&
    (lineOffset < 0 ? args.n_lines >= -lineOffset : lineOffset + args.n_lines - 1 >= totalLines);
  return JSON.stringify([lineOffset, reachesEnd ? undefined : args.n_lines, args.column_offset ?? 0]);
}

function overlap(ranges: readonly LineRange[], start: number, end: number): number {
  let total = 0;
  for (const [from, to] of ranges) {
    total += Math.max(0, Math.min(to, end) - Math.max(from, start) + 1);
  }
  return total;
}

function addRange(ranges: readonly LineRange[], start: number, end: number): LineRange[] {
  const merged: [number, number][] = [];
  for (const [from, to] of [...ranges, [start, end] as const].toSorted((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged.slice(-MAX_LINE_RANGES);
}

function fileExtension(file: string): string {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1, dot + 17).toLowerCase();
}
