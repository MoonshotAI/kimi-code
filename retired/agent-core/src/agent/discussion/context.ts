/**
 * DiscussionContext — shared discussion transcript for multi-agent roundtables.
 *
 * This is a pure data class that stores the ordered list of discussion entries
 * (speaker, agentId, content, round) and can render the full transcript as a
 * text block to be injected into each participant agent's context.
 *
 * There is no dependency on Agent, TurnFlow, or any other core module — it is
 * a standalone value object.
 */

export interface DiscussionEntry {
  readonly speaker: string;
  readonly agentId: string;
  readonly content: string;
  readonly round: number;
}

export type DebatePhase = 'opening' | 'free_debate' | 'closing' | 'consensus';

export interface PositionRecord {
  readonly speaker: string;
  readonly stance: string;
  readonly keyPoints: readonly string[];
  readonly round: number;
}

export interface CrossReference {
  readonly speaker: string;
  readonly targetSpeaker: string;
  readonly targetRound: number;
  readonly stance: 'agree' | 'disagree' | 'clarify' | 'extend';
  readonly content: string;
  readonly round: number;
}

export class DiscussionContext {
  private readonly entries: DiscussionEntry[] = [];
  private readonly positions: PositionRecord[] = [];
  private readonly crossRefs: CrossReference[] = [];
  private currentPhase: DebatePhase = 'opening';

  addEntry(
    speaker: string,
    agentId: string,
    content: string,
    round: number,
  ): void {
    this.entries.push({ speaker, agentId, content, round });
    // Auto-detect cross-references from content
    this.detectCrossReferences(speaker, content, round);
  }

  /** The current round number (1-based). 0 before any entry. */
  getRound(): number {
    if (this.entries.length === 0) return 0;
    return this.entries[this.entries.length - 1]!.round;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  lastSpeaker(): string | null {
    if (this.entries.length === 0) return null;
    return this.entries[this.entries.length - 1]!.speaker;
  }

  latestEntry(): DiscussionEntry | null {
    if (this.entries.length === 0) return null;
    return this.entries[this.entries.length - 1]!;
  }

  allEntries(): readonly DiscussionEntry[] {
    return [...this.entries];
  }

  /** Total number of entries (speeches) recorded. */
  entryCount(): number {
    return this.entries.length;
  }

  // ── Debate-specific features ──

  setPhase(phase: DebatePhase): void {
    this.currentPhase = phase;
  }

  getPhase(): DebatePhase {
    return this.currentPhase;
  }

  /** Record a participant's stated position on the topic. */
  recordPosition(
    speaker: string,
    stance: string,
    keyPoints: readonly string[],
    round: number,
  ): void {
    // Update or append — latest position per speaker is authoritative
    const existing = this.positions.findIndex((p) => p.speaker === speaker);
    const record: PositionRecord = { speaker, stance, keyPoints, round };
    if (existing >= 0) {
      this.positions[existing] = record;
    } else {
      this.positions.push(record);
    }
  }

  /** Get the latest recorded position for a speaker. */
  getPosition(speaker: string): PositionRecord | undefined {
    return this.positions.find((p) => p.speaker === speaker);
  }

  /** All recorded positions. */
  allPositions(): readonly PositionRecord[] {
    return [...this.positions];
  }

  /** All detected cross-references. */
  allCrossReferences(): readonly CrossReference[] {
    return [...this.crossRefs];
  }

  /**
   * Render positions as a text block for injection into debate prompts.
   */
  getPositionsText(): string {
    if (this.positions.length === 0) return '';
    return this.positions
      .map(
        (p) => `[${p.speaker}] Stance: ${p.stance}\n  Key points: ${p.keyPoints.join(', ')}`,
      )
      .join('\n');
  }

  /**
   * Render the full discussion transcript as a text block suitable for
   * injection into a participant agent's context.
   */
  getTranscript(): string {
    if (this.entries.length === 0) return '';

    return this.entries
      .map((entry) => `[${entry.speaker}] ${entry.content}`)
      .join('\n\n');
  }

  /** Render transcript with phase markers. */
  getDebateTranscript(): string {
    if (this.entries.length === 0) return '';

    const lines: string[] = [];
    let lastPhase: DebatePhase | undefined;

    for (const entry of this.entries) {
      const phase = this.inferPhaseForEntry(entry);
      if (phase !== lastPhase) {
        lines.push(`\n=== ${phaseLabel(phase)} ===\n`);
        lastPhase = phase;
      }
      lines.push(`[${entry.speaker}] ${entry.content}`);
    }

    return lines.join('\n\n');
  }

  private inferPhaseForEntry(_entry: DiscussionEntry): DebatePhase {
    return this.currentPhase;
  }

  /**
   * Detect simple cross-references in speech content.
   * Looks for patterns like "@Speaker", "as Speaker said", "Speaker's point".
   */
  private detectCrossReferences(
    speaker: string,
    content: string,
    round: number,
  ): void {
    // Match known speakers mentioned in the content
    const knownSpeakers = new Set(this.entries.map((e) => e.speaker));
    for (const target of knownSpeakers) {
      if (target === speaker) continue;

      // Check various reference patterns
      const refPatterns = [
        new RegExp(`@${escapeRegex(target)}`, 'i'),
        new RegExp(`as ${escapeRegex(target)} (said|mentioned|argued|pointed out)`, 'i'),
        new RegExp(`${escapeRegex(target)}['’]s (point|argument|suggestion|idea|proposal)`, 'i'),
        new RegExp(`(agree|disagree) with ${escapeRegex(target)}`, 'i'),
        new RegExp(`(building|expanding) on ${escapeRegex(target)}`, 'i'),
      ];

      const found = refPatterns.some((p) => p.test(content));
      if (!found) continue;

      // Determine stance
      let stance: CrossReference['stance'] = 'clarify';
      if (/\bagree\b/i.test(content) || /\bsupport\b/i.test(content) || /\bsecond\b/i.test(content)) {
        stance = 'agree';
      } else if (/\bdisagree\b/i.test(content) || /\brespectfully\b.*\bdisagree\b/i.test(content) || /\bcounter\b/i.test(content) || /\bpush back\b/i.test(content)) {
        stance = 'disagree';
      } else if (/\bextend\b/i.test(content) || /\bbuild(?:ing)? on\b/i.test(content) || /\bad[d]?\b.*\bpoint\b/i.test(content)) {
        stance = 'extend';
      }

      this.crossRefs.push({
        speaker,
        targetSpeaker: target,
        targetRound: round - 1 >= 1 ? round - 1 : 1,
        stance,
        content: content.slice(0, 200),
        round,
      });
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phaseLabel(phase: DebatePhase): string {
  switch (phase) {
    case 'opening': return 'Opening Statements';
    case 'free_debate': return 'Free Debate';
    case 'closing': return 'Closing Arguments';
    case 'consensus': return 'Consensus & Resolution';
  }
}