import { addUsage, type TokenUsage } from '@moonshot-ai/kosong';

import {
  DiscussionContext,
  type DebatePhase,
  type DiscussionEntry,
} from './context';
import type {
  DiscussionObserver,
  DiscussionTurnEvent,
} from './coordinator';
import type { SessionSubagentHost } from '../../session/subagent-host';

/**
 * Configuration for a single debate participant.
 */
export interface DebateParticipantConfig {
  /** Agent profile name, e.g. 'researcher', 'coder', 'explore'. */
  readonly profileName: string;
  /** Role description injected into the agent's prompt each turn. */
  readonly roleDescription: string;
  /** Optional stance this participant should take (e.g. "argue for migration"). */
  readonly assignedStance?: string;
}

/**
 * Options for starting a structured debate.
 */
export interface DebateOptions {
  /** The topic or question to debate. */
  readonly topic: string;
  /** The participants in the debate. */
  readonly participants: DebateParticipantConfig[];
  /** Maximum number of free-debate rounds before closing (default: 2). */
  readonly maxDebateRounds?: number;
  /** Optional: prompt used to generate a final summary/consensus. */
  readonly consensusPrompt?: string;
  /** Whether to include a voting phase (default: false). */
  readonly enableVoting?: boolean;
}

/**
 * The result of a completed debate.
 */
export interface DebateResult {
  /** Ordered list of every speech in the debate. */
  readonly transcript: readonly DiscussionEntry[];
  /** Phase-by-phase breakdown. */
  readonly phases: readonly { phase: DebatePhase; entryCount: number }[];
  /** A final consensus/summary (empty string if none was generated). */
  readonly consensus: string;
  /** Voting result (empty string if voting was not enabled). */
  readonly votingResult: string;
  /** How the debate ended. */
  readonly endedBy: 'completed' | 'cancelled' | 'failed';
  /** Aggregate token usage across all participants. */
  readonly usage: TokenUsage;
  /** Cross-references detected during the debate. */
  readonly crossReferencesCount: number;
  /** How many participants changed their stated position. */
  readonly positionChanges: number;
}

/**
 * StructuredDebateCoordinator — orchestrates a structured, multi-phase debate
 * among multiple persistent subagents.
 *
 * Phases:
 *   1. Opening Statements — each participant presents their initial stance
 *   2. Free Debate — participants respond to and challenge each other
 *   3. Closing Arguments — each participant delivers a final summary
 *   4. Consensus (optional) — extract agreed/disagreed points
 */
export class StructuredDebateCoordinator {
  private readonly agentIds: string[] = [];
  private readonly observer: DiscussionObserver | undefined;

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    options?: { readonly observer?: DiscussionObserver },
  ) {
    this.observer = options?.observer;
  }

  /**
   * Run a structured debate and return the result.
   */
  async debate(
    options: DebateOptions,
    signal: AbortSignal,
  ): Promise<DebateResult> {
    const context = new DiscussionContext();
    let endedBy: DebateResult['endedBy'] = 'completed';

    try {
      // 1. Create persistent subagents for each participant
      for (const participant of options.participants) {
        signal.throwIfAborted();
        const agentId = await this.subagentHost.spawnPersistent({
          profileName: participant.profileName,
          prompt: '',
          description: participant.roleDescription,
          parentToolCallId: 'debate',
          runInBackground: false,
          signal,
        });
        this.agentIds.push(agentId);
      }

      // Track position changes
      const initialPositions = new Map<string, string>();

      // 2. Phase 1: Opening Statements
      context.setPhase('opening');
      for (const [index, participant] of options.participants.entries()) {
        signal.throwIfAborted();
        const content = await this.runOpeningStatement(
          index,
          participant,
          options.topic,
          context,
          signal,
        );
        context.addEntry(participant.profileName, this.agentIds[index]!, content, 1);

        // Record initial position
        const stance = this.extractStance(content);
        initialPositions.set(participant.profileName, stance);
        context.recordPosition(participant.profileName, stance, this.extractKeyPoints(content), 1);

        this.emitTurn(participant.profileName, this.agentIds[index]!, 1, content);
      }

      // 3. Phase 2: Free Debate (multiple rounds)
      context.setPhase('free_debate');
      const maxDebateRounds = options.maxDebateRounds ?? 2;
      let roundOffset = 1;
      for (let round = 1; round <= maxDebateRounds; round += 1) {
        signal.throwIfAborted();
        const currentRound = roundOffset + round;

        for (const [index, participant] of options.participants.entries()) {
          signal.throwIfAborted();
          const agentId = this.agentIds[index]!;

          const prompt = this.buildDebateRoundPrompt(
            participant.roleDescription,
            options.topic,
            participant.profileName,
            context,
            currentRound,
          );

          const content = await this.subagentHost.runDiscussionTurn(
            agentId,
            prompt,
            signal,
          );
          context.addEntry(participant.profileName, agentId, content, currentRound);

          // Update position if changed
          const newStance = this.extractStance(content);
          if (newStance && newStance !== context.getPosition(participant.profileName)?.stance) {
            context.recordPosition(
              participant.profileName,
              newStance,
              this.extractKeyPoints(content),
              currentRound,
            );
          }

          this.emitTurn(participant.profileName, agentId, currentRound, content);
        }
      }

      // 4. Phase 3: Closing Arguments
      context.setPhase('closing');
      const closingRound = roundOffset + maxDebateRounds + 1;
      for (const [index, participant] of options.participants.entries()) {
        signal.throwIfAborted();
        const agentId = this.agentIds[index]!;

        const prompt = this.buildClosingPrompt(
          participant.roleDescription,
          options.topic,
          participant.profileName,
          context,
          closingRound,
        );

        const content = await this.subagentHost.runDiscussionTurn(
          agentId,
          prompt,
          signal,
        );
        context.addEntry(participant.profileName, agentId, content, closingRound);

        const finalStance = this.extractStance(content);
        if (finalStance) {
          context.recordPosition(
            participant.profileName,
            finalStance,
            this.extractKeyPoints(content),
            closingRound,
          );
        }

        this.emitTurn(participant.profileName, agentId, closingRound, content);
      }

      // Count position changes
      let positionChanges = 0;
      for (const [speaker, initial] of initialPositions) {
        const current = context.getPosition(speaker);
        if (current && current.stance !== initial) {
          positionChanges += 1;
        }
      }

      // 5. Phase 4: Consensus (optional)
      context.setPhase('consensus');
      let consensus = '';
      if (options.consensusPrompt !== undefined && !context.isEmpty()) {
        consensus = await this.generateConsensus(
          options.consensusPrompt,
          context,
          signal,
        );
      }

      // 6. Voting (optional)
      let votingResult = '';
      if (options.enableVoting && !context.isEmpty()) {
        votingResult = await this.runVoting(options.topic, context, signal);
      }

      // 7. Collect aggregate usage
      const usage = this.collectUsage();

      // Build phase breakdown
      const phases = this.buildPhaseBreakdown(context);

      return {
        transcript: context.allEntries(),
        phases,
        consensus,
        votingResult,
        endedBy,
        usage,
        crossReferencesCount: context.allCrossReferences().length,
        positionChanges,
      };
    } catch (error) {
      if (isCancelled(error, signal)) {
        endedBy = 'cancelled';
      } else {
        endedBy = 'failed';
      }

      const usage = this.collectUsage();
      const phases = this.buildPhaseBreakdown(context);

      return {
        transcript: context.allEntries(),
        phases,
        consensus: '',
        votingResult: '',
        endedBy,
        usage,
        crossReferencesCount: context.allCrossReferences().length,
        positionChanges: 0,
      };
    } finally {
      await this.destroyAll();
    }
  }

  private async runOpeningStatement(
    index: number,
    participant: DebateParticipantConfig,
    topic: string,
    context: DiscussionContext,
    signal: AbortSignal,
  ): Promise<string> {
    const agentId = this.agentIds[index]!;
    const stanceHint = participant.assignedStance
      ? `\nYour assigned stance: ${participant.assignedStance}`
      : '';

    const prompt = [
      `[System] Your role:\n${participant.roleDescription}`,
      '',
      `Debate topic:\n${topic}`,
      '',
      '=== OPENING STATEMENTS ===',
      '',
      'You are delivering your opening statement. Present your initial stance',
      `on the topic clearly. State your position, your key arguments, and what`,
      `you believe is the most important consideration.${stanceHint}`,
      '',
      'Be thorough and persuasive — this is your chance to frame the debate.',
    ].join('\n');

    return await this.subagentHost.runDiscussionTurn(agentId, prompt, signal);
  }

  private buildDebateRoundPrompt(
    roleDescription: string,
    topic: string,
    speakerName: string,
    context: DiscussionContext,
    round: number,
  ): string {
    const parts: string[] = [];

    parts.push(`[System] Your role:\n${roleDescription}`);
    parts.push('');
    parts.push(`Debate topic:\n${topic}`);
    parts.push('');

    // Show current positions
    const positionsText = context.getPositionsText();
    if (positionsText) {
      parts.push('=== CURRENT POSITIONS ===');
      parts.push(positionsText);
      parts.push('');
    }

    parts.push(`=== FREE DEBATE — Round ${round} ===`);
    parts.push('');

    const transcript = context.getTranscript();
    if (transcript) {
      parts.push('Full debate transcript so far:');
      parts.push(transcript);
      parts.push('');
      parts.push(
        'Respond to what others have said. You may:',
        '- Challenge or support specific points made by other participants',
        '- Provide counter-arguments or additional evidence',
        '- Clarify or refine your position',
        '- Point out flaws in opposing arguments',
        '',
        'Be specific when referring to others — mention their name and which',
        'point you are addressing. This is a fast-paced debate round.',
      );
    } else {
      parts.push('Present your arguments on the topic.');
    }

    return parts.join('\n');
  }

  private buildClosingPrompt(
    roleDescription: string,
    topic: string,
    speakerName: string,
    context: DiscussionContext,
    round: number,
  ): string {
    const positionsText = context.getPositionsText();
    const crossRefs = context.allCrossReferences();
    const crossRefText = crossRefs.length > 0
      ? `\nCross-references detected:\n${
          crossRefs.map(
            (r) => `  [${r.speaker}] → @${r.targetSpeaker} (${r.stance})`,
          ).join('\n')
        }`
      : '';

    return [
      `[System] Your role:\n${roleDescription}`,
      '',
      `Debate topic:\n${topic}`,
      '',
      '=== CLOSING ARGUMENTS ===',
      '',
      'The debate is concluding. Deliver your closing argument:',
      '',
      '- Summarize your position and key evidence',
      '- Address the strongest counter-arguments raised against your view',
      '- Explain why your position should prevail',
      '- Be concise and impactful',
      '',
      'Current positions:',
      positionsText,
      crossRefText,
      '',
      'Full debate transcript:',
      context.getTranscript(),
    ].join('\n');
  }

  private async generateConsensus(
    consensusPrompt: string,
    context: DiscussionContext,
    signal: AbortSignal,
  ): Promise<string> {
    const firstAgentId = this.agentIds[0];
    if (firstAgentId === undefined) return '';

    try {
      const positions = context.allPositions();
      const positionsBlock = positions.length > 0
        ? `\nFinal positions:\n${
            positions.map(
              (p) => `[${p.speaker}] ${p.stance}\n  Key points: ${p.keyPoints.join(', ')}`,
            ).join('\n')
          }`
        : '';

      const crossRefs = context.allCrossReferences();
      const agreements = crossRefs.filter((r) => r.stance === 'agree').length;
      const disagreements = crossRefs.filter((r) => r.stance === 'disagree').length;

      const prompt = [
        consensusPrompt,
        '',
        'Full debate transcript:',
        context.getTranscript(),
        positionsBlock,
        '',
        `Agreements detected: ${agreements}, Disagreements detected: ${disagreements}`,
        '',
        'Please provide:',
        '1. Points of consensus (what everyone agrees on)',
        '2. Remaining disagreements (where opinions still differ)',
        '3. Key insights and takeaways from the debate',
        '4. Recommended next steps or action items',
      ].join('\n');

      return await this.subagentHost.runDiscussionTurn(
        firstAgentId,
        prompt,
        signal,
      );
    } catch {
      return '';
    }
  }

  /**
   * Run a voting phase where each participant votes on key questions.
   */
  private async runVoting(
    topic: string,
    context: DiscussionContext,
    signal: AbortSignal,
  ): Promise<string> {
    const positions = context.allPositions();
    const crossRefs = context.allCrossReferences();
    const agreements = crossRefs.filter((r) => r.stance === 'agree').length;
    const disagreements = crossRefs.filter((r) => r.stance === 'disagree').length;

    const positionsBlock = positions.length > 0
      ? `\nPositions:\n${
          positions.map((p) => `[${p.speaker}] ${p.stance}`).join('\n')
        }`
      : '';

    // Collect votes from all participants
    const votes: string[] = [];
    for (const [index, participant] of this.agentIds.entries()) {
      signal.throwIfAborted();
      const speakerName = positions[index]?.speaker ?? `Participant ${index + 1}`;

      const prompt = [
        `[System] Your role:\n${positions[index]?.speaker ?? ''}`,
        '',
        `Debate topic:\n${topic}`,
        '',
        '=== VOTING PHASE ===',
        '',
        'Based on the full debate, please vote on the following:',
        '',
        positionsBlock,
        '',
        `Agreements detected: ${agreements}, Disagreements detected: ${disagreements}`,
        '',
        'Full debate transcript:',
        context.getTranscript(),
        '',
        'Please respond with:',
        '1. Your final position on the topic (yes/no/neutral with reasoning)',
        '2. The single most convincing argument from the debate',
        '3. A suggested compromise or path forward',
      ].join('\n');

      try {
        const vote = await this.subagentHost.runDiscussionTurn(participant, prompt, signal);
        votes.push(`[${speakerName}] ${vote}`);
      } catch {
        votes.push(`[${speakerName}] <vote not cast>`);
      }
    }

    // Tally results using the first participant
    const firstAgentId = this.agentIds[0];
    if (firstAgentId === undefined || votes.length === 0) return '';

    try {
      const tallyPrompt = [
        'Tally the votes from this debate and produce a final verdict.',
        '',
        'Topic:',
        topic,
        '',
        'Votes:',
        ...votes,
        '',
        'Please provide:',
        '1. Vote count (how many for each position)',
        '2. The majority position',
        '3. Key arguments that swayed the outcome',
        '4. Final recommended decision',
      ].join('\n');

      return await this.subagentHost.runDiscussionTurn(firstAgentId, tallyPrompt, signal);
    } catch {
      return '';
    }
  }

  private extractStance(content: string): string {
    // Simple extraction: first sentence as stance summary
    const firstSentence = content.split(/[.!?\n]/).filter(Boolean)[0];
    return firstSentence?.trim() ?? '';
  }

  private extractKeyPoints(content: string): string[] {
    // Extract bullet points and numbered items
    const points: string[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (/^[-*•]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
        points.push(trimmed.replace(/^[-*•]\s|^\d+[.)]\s/, ''));
      }
    }
    // Fallback: split into sentences and take first 3
    if (points.length === 0) {
      const sentences = content
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10);
      points.push(...sentences.slice(0, 3));
    }
    return points.slice(0, 5);
  }

  private buildPhaseBreakdown(
    context: DiscussionContext,
  ): { phase: DebatePhase; entryCount: number }[] {
    const entries = context.allEntries();
    if (entries.length === 0) return [];

    // Estimate phases based on entry distribution
    const opening = entries.filter((e) => e.round === 1);
    const closing = entries.filter((e) => e.round === entries[entries.length - 1]!.round);
    const freeDebate = entries.filter(
      (e) => e.round > 1 && e.round < entries[entries.length - 1]!.round,
    );

    const phases: { phase: DebatePhase; entryCount: number }[] = [
      { phase: 'opening', entryCount: opening.length },
      { phase: 'free_debate', entryCount: freeDebate.length },
      { phase: 'closing', entryCount: closing.length },
    ];
    return phases.filter((p) => p.entryCount > 0);
  }

  private collectUsage(): TokenUsage {
    let total: TokenUsage | undefined;

    for (const agentId of this.agentIds) {
      const usage = this.subagentHost.getPersistentUsage(agentId);
      if (usage === undefined) continue;
      total = total === undefined ? { ...usage } : addUsage(total, usage);
    }

    return total ?? { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
  }

  private emitTurn(
    roleName: string,
    agentId: string,
    round: number,
    content: string,
  ): void {
    this.observer?.({ agentId, roleName, round, content } satisfies DiscussionTurnEvent);
  }

  private async destroyAll(): Promise<void> {
    for (const agentId of this.agentIds) {
      try {
        await this.subagentHost.destroyPersistent(agentId);
      } catch {
        // Best-effort cleanup
      }
    }
    this.agentIds.length = 0;
  }
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}
