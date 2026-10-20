import { extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LoopRecord } from '@moonshot-ai/agent-core/loop/index';
import type { SessionEvent } from '@moonshot-ai/agent-core/session/index';
import { decodeCommit, type Commit, type Journal } from '@moonshot-ai/agent-core/store/index';

export interface SessionJournalScan {
  readonly firstActivityMs?: number;
  readonly lastActivityMs?: number;
  readonly lastUserMessageMs?: number;
  readonly firstUserInput?: string;
}

export interface SessionLogData {
  readonly name: string;
  readonly lines: readonly string[];
}

export async function readSessionLogs(
  journal: Journal,
  signal?: AbortSignal,
): Promise<readonly SessionLogData[]> {
  signal?.throwIfAborted();
  const names = await journal.names('');
  const logs: SessionLogData[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    const lines: string[] = [];
    for await (const line of journal.lines(name, 0)) lines.push(line);
    logs.push({ name, lines });
  }
  return logs;
}

export function scanSessionLogs(logs: readonly SessionLogData[]): SessionJournalScan {
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let lastUserMessageMs: number | undefined;
  let firstUserInput: string | undefined;

  for (const log of logs) {
    for (const line of log.lines) {
      const commit = decodeLine(line);
      if (commit === undefined) continue;
      const timeMs = commit.time > 0 ? commit.time : undefined;
      if (timeMs !== undefined) {
        firstActivityMs = minDefined(firstActivityMs, timeMs);
        lastActivityMs = maxDefined(lastActivityMs, timeMs);
      }
      for (const event of commit.events ?? []) {
        if (event.type !== 'message.appended') continue;
        const message = event.entry.message;
        if (message.role !== 'user') continue;
        const text = extractText(message);
        if (timeMs !== undefined) {
          lastUserMessageMs = maxDefined(lastUserMessageMs, timeMs);
        }
        if (firstUserInput === undefined && text.trim().length > 0) {
          firstUserInput = text;
        }
      }
    }
  }

  return {
    firstActivityMs,
    lastActivityMs,
    lastUserMessageMs,
    firstUserInput,
  };
}

function decodeLine(line: string): Commit<SessionEvent | LoopRecord> | undefined {
  try {
    return decodeCommit<SessionEvent | LoopRecord>(line);
  } catch {
    return undefined;
  }
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
