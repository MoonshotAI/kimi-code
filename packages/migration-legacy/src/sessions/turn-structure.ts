import type { NormalizedContentPart } from './content-part.js';

export interface TurnMessage {
  readonly role: string;
  readonly content?: readonly NormalizedContentPart[];
}

export interface ImportedTurn {
  readonly messages: readonly TurnMessage[];
  readonly opensWithUser: boolean;
}

export interface WireRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

// Turn boundaries mirror the transcript projector's grouping rule (one turn
// per user message, plus a fallback turn for a leading non-user run left over
// from a compaction-truncated context). Keeping this in lockstep with
// `groupMessagesIntoSnapshot` is what makes the restored turn clock line up
// with the cold transcript grouping — one synthesized `turn.prompt` per
// grouped turn, so the first live turn after resume never collides with an
// imported one.
export function splitIntoTurns(messages: readonly TurnMessage[]): ImportedTurn[] {
  const turns: ImportedTurn[] = [];
  let current: TurnMessage[] = [];
  let opensWithUser = false;
  const flush = (): void => {
    if (current.length === 0) return;
    turns.push({ messages: current, opensWithUser });
    current = [];
    opensWithUser = false;
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      current = [message];
      opensWithUser = true;
      continue;
    }
    current.push(message);
  }
  flush();
  return turns;
}

export function turnHasAssistantContent(turn: ImportedTurn): boolean {
  return turn.messages.some((message) => message.role === 'assistant');
}

export function buildTurnRecords(
  turns: readonly ImportedTurn[],
  opts: { readonly agentId: string; readonly time: number },
): WireRecord[] {
  const records: WireRecord[] = [];
  turns.forEach((turn, turnId) => {
    const opener = turn.opensWithUser ? turn.messages[0] : undefined;
    records.push({
      type: 'turn.prompt',
      agentId: opts.agentId,
      input: opener?.content ?? [],
      origin: turn.opensWithUser
        ? { kind: 'user' }
        : { kind: 'system_trigger', name: 'imported_orphan' },
      time: opts.time,
    });
    for (const message of turn.messages) {
      records.push({ type: 'context.append_message', message });
    }
    if (turnHasAssistantContent(turn)) {
      records.push({
        type: 'turn.ended',
        agentId: opts.agentId,
        turnId,
        reason: 'completed',
        time: opts.time,
      });
    }
  });
  return records;
}
