import type { Message, ToolCall } from '#/kosong/contract/message';

export function collectToolCallIds(messages: readonly Message[]): readonly string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const call of message.toolCalls) ids.push(call.id);
    if (message.toolCallId !== undefined) ids.push(message.toolCallId);
  }
  return ids;
}

export class ToolCallIdResponseNormalizer {
  private readonly seen: Set<string>;
  private readonly assignedByIndex = new Map<number | string, string>();
  private readonly occurrencesByRawId = new Map<string, string[]>();
  private readonly claimed: string[] = [];
  readonly remapped: { raw: string; assigned: string }[] = [];

  constructor(seen: ReadonlySet<string>) {
    this.seen = new Set(seen);
  }

  get claimedIds(): readonly string[] {
    return this.claimed;
  }

  remapStreamedId(rawId: string, streamIndex: number | string | undefined): string {
    if (streamIndex !== undefined) {
      const existing = this.assignedByIndex.get(streamIndex);
      if (existing !== undefined) return existing;
    }
    const occurrences = this.occurrencesByRawId.get(rawId) ?? [];
    const assigned = this.claim(rawId, occurrences.length);
    this.occurrencesByRawId.set(rawId, [...occurrences, assigned]);
    if (streamIndex !== undefined) this.assignedByIndex.set(streamIndex, assigned);
    return assigned;
  }

  remapFinalizedCalls(toolCalls: ToolCall[]): ToolCall[] {
    if (toolCalls.length === 0) return toolCalls;
    const counts = new Map<string, number>();
    let changed = false;
    const result = toolCalls.map((call) => {
      const occurrence = counts.get(call.id) ?? 0;
      counts.set(call.id, occurrence + 1);
      const assigned =
        this.occurrencesByRawId.get(call.id)?.[occurrence] ?? this.claim(call.id, occurrence);
      if (assigned === call.id) return call;
      changed = true;
      return { ...call, id: assigned };
    });
    return changed ? result : toolCalls;
  }

  private claim(rawId: string, occurrence: number): string {
    if (occurrence === 0 && !this.seen.has(rawId)) {
      this.seen.add(rawId);
      this.claimed.push(rawId);
      return rawId;
    }
    let n = Math.max(occurrence + 1, 2);
    let candidate = `${rawId}__${n}`;
    while (this.seen.has(candidate)) {
      n += 1;
      candidate = `${rawId}__${n}`;
    }
    this.seen.add(candidate);
    this.claimed.push(candidate);
    this.remapped.push({ raw: rawId, assigned: candidate });
    return candidate;
  }
}
