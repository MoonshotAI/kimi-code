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
  readonly nextLine?: number;
}

export interface ReadObservation {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly file: string;
  readonly args: ReadInput;
  readonly stat: HostFileStat;
  readonly text: string;
  readonly facts: ReadPageFacts;
}

interface FileReadState {
  readonly size: number;
  readonly mtimeMs?: number;
  readonly ranges: Set<string>;
  readonly nextLine?: number;
}

const MAX_TRACKED_FILES = 2048;

export class ReadActivity {
  private readonly files = new Map<string, FileReadState>();

  observe(observation: ReadObservation): ReadFileEvent {
    const { args, stat, facts } = observation;
    const range = JSON.stringify([args.line_offset ?? 1, args.n_lines, args.column_offset ?? 0, args.max_chars]);
    const previous = this.files.get(observation.file);
    const changed = previous !== undefined && (previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs);
    const ranges = previous === undefined || changed ? new Set<string>() : previous.ranges;
    const event: ReadFileEvent = {
      turn_id: observation.turnId,
      tool_call_id: observation.toolCallId,
      ext: fileExtension(observation.file),
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
      reread_unchanged: ranges.has(range),
      changed_since_last_read: changed,
      continues_previous_page: previous?.nextLine !== undefined && args.line_offset === previous.nextLine,
    };
    ranges.add(range);
    this.files.delete(observation.file);
    if (this.files.size >= MAX_TRACKED_FILES) {
      const oldest = this.files.keys().next();
      if (oldest.done !== true) this.files.delete(oldest.value);
    }
    this.files.set(observation.file, { size: stat.size, mtimeMs: stat.mtimeMs, ranges, nextLine: facts.nextLine });
    return event;
  }
}

function fileExtension(file: string): string {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1, dot + 17).toLowerCase();
}
