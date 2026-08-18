import type { Message, ToolCall } from '#/kosong/contract/message';

export class ToolCallIdNormalizer {
  private readonly seen = new Set<string>();
  private seeded = false;

  seedFrom(messages: readonly Message[]): void {
    if (this.seeded) return;
    this.seeded = true;
    for (const message of messages) {
      for (const call of message.toolCalls) this.seen.add(call.id);
      if (message.toolCallId !== undefined) this.seen.add(message.toolCallId);
    }
  }

  beginResponse(): ToolCallIdResponseNormalizer {
    return new ToolCallIdResponseNormalizer(this.seen);
  }
}

export class ToolCallIdResponseNormalizer {
  private readonly assignedByIndex = new Map<number | string, string>();
  private readonly occurrencesByRawId = new Map<string, string[]>();
  private readonly claimed: string[] = [];
  /** Every rewrite applied to this response, oldest first (for provenance logging). */
  readonly remapped: { raw: string; assigned: string }[] = [];

  constructor(private readonly seen: Set<string>) {}

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

  rollback(): void {
    for (const id of this.claimed) this.seen.delete(id);
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
