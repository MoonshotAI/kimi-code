import { addUsage, type TokenUsage } from '@moonshot-ai/kosong';

import { DiscussionContext, type DiscussionEntry } from './context';
import type { SessionSubagentHost } from '../../session/subagent-host';

/**
 * Configuration for a single discussion participant.
 */
export interface DiscussionParticipantConfig {
  /** Agent profile name, e.g. 'researcher', 'coder', 'explore'. */
  readonly profileName: string;
  /** Role description injected into the agent's prompt each turn. */
  readonly roleDescription: string;
  /** How many times this participant speaks per round (default: 1). */
  readonly turnsPerRound?: number;
}

/**
 * Options for starting a roundtable discussion.
 */
export interface DiscussionOptions {
  /** The topic or question to discuss. */
  readonly topic: string;
  /** The participants in the discussion. */
  readonly participants: DiscussionParticipantConfig[];
  /** Maximum number of full rounds before the discussion ends (default: 3). */
  readonly maxRounds?: number;
  /** Optional: prompt used to generate a final summary after the discussion. */
  readonly summaryPrompt?: string;
}

/**
 * The result of a completed discussion.
 */
export interface DiscussionResult {
  /** Ordered list of every speech in the discussion. */
  readonly transcript: readonly DiscussionEntry[];
  /** A final summary (empty string if none was generated). */
  readonly summary: string;
  /** How many full rounds were completed. */
  readonly roundsCompleted: number;
  /** How the discussion ended. */
  readonly endedBy: 'max_rounds' | 'cancelled' | 'failed';
  /** Aggregate token usage across all participants. */
  readonly usage: TokenUsage;
}

/**
 * DiscussionTurnEvent — emitted by the coordinator so external code (e.g. the
 * TUI) can observe each turn as it happens.
 */
export interface DiscussionTurnEvent {
  readonly agentId: string;
  readonly roleName: string;
  readonly round: number;
  readonly content: string;
}

export type DiscussionObserver = (event: DiscussionTurnEvent) => void;

/**
 * SwarmDiscussionCoordinator — orchestrates a roundtable discussion among
 * multiple persistent subagents.
 *
 * Each participant is a persistent subagent that receives the full discussion
 * transcript before their turn. They speak naturally, like a human in a
 * roundtable, with no special tools or communication primitives.
 */
export class SwarmDiscussionCoordinator {
  private readonly agentIds: string[] = [];
  private readonly observer: DiscussionObserver | undefined;

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    options?: { readonly observer?: DiscussionObserver },
  ) {
    this.observer = options?.observer;
  }

  /**
   * Run a roundtable discussion and return the result.
   */
  async discuss(
    options: DiscussionOptions,
    signal: AbortSignal,
  ): Promise<DiscussionResult> {
    const maxRounds = options.maxRounds ?? 3;
    const context = new DiscussionContext();
    let endedBy: DiscussionResult['endedBy'] = 'max_rounds';

    // 1. Create persistent subagents for each participant
    try {
      for (const participant of options.participants) {
        signal.throwIfAborted();
        const agentId = await this.subagentHost.spawnPersistent({
          profileName: participant.profileName,
          prompt: '', // No initial prompt — we inject per turn
          description: participant.roleDescription,
          parentToolCallId: 'discussion',
          runInBackground: false,
          signal,
        });
        this.agentIds.push(agentId);
      }

      // 2. Round-robin discussion loop
      let roundsCompleted = 0;
      for (let round = 1; round <= maxRounds; round += 1) {
        signal.throwIfAborted();

        for (const [index, participant] of options.participants.entries()) {
          signal.throwIfAborted();
          const agentId = this.agentIds[index]!;
          const turnsThisRound = participant.turnsPerRound ?? 1;

          for (let turn = 0; turn < turnsThisRound; turn += 1) {
            signal.throwIfAborted();

            // Build prompt: role + topic + transcript
            const prompt = this.buildTurnPrompt(
              participant.roleDescription,
              options.topic,
              context,
            );

            // Run the turn
            const content = await this.subagentHost.runDiscussionTurn(
              agentId,
              prompt,
              signal,
            );

            // Record the speech
            context.addEntry(
              participant.profileName,
              agentId,
              content,
              round,
            );

            // Notify observer (e.g. TUI)
            this.observer?.({
              agentId,
              roleName: participant.profileName,
              round,
              content,
            });
          }
        }

        roundsCompleted = round;
      }

      // 3. Generate summary if requested
      let summary = '';
      if (options.summaryPrompt !== undefined && !context.isEmpty()) {
        summary = await this.generateSummary(
          options.summaryPrompt,
          context,
          signal,
        );
      }

      // 4. Collect aggregate usage
      const usage = this.collectUsage();

      return {
        transcript: context.allEntries(),
        summary,
        roundsCompleted,
        endedBy,
        usage,
      };
    } catch (error) {
      if (isCancelled(error, signal)) {
        endedBy = 'cancelled';
      } else {
        endedBy = 'failed';
      }

      const usage = this.collectUsage();
      return {
        transcript: context.allEntries(),
        summary: '',
        roundsCompleted: context.getRound(),
        endedBy,
        usage,
      };
    } finally {
      // 5. Cleanup: destroy all persistent subagents
      await this.destroyAll();
    }
  }

  /**
   * Build the prompt for a single participant's turn.
   */
  private buildTurnPrompt(
    roleDescription: string,
    topic: string,
    context: DiscussionContext,
  ): string {
    const parts: string[] = [];

    // Role description
    parts.push(`[System] Your role:\n${roleDescription}`);
    parts.push('');

    // Topic
    parts.push(`Discussion topic:\n${topic}`);
    parts.push('');

    // Transcript so far
    const transcript = context.getTranscript();
    if (transcript.length > 0) {
      parts.push('Current discussion transcript:');
      parts.push(transcript);
      parts.push('');
      parts.push(
        'Continue the discussion based on what has been said so far. ' +
          'Respond naturally, as if you are in a roundtable conversation.',
      );
    } else {
      parts.push(
        'You are the first to speak. Present your initial thoughts ' +
          'on the topic.',
      );
    }

    return parts.join('\n');
  }

  /**
   * Generate a final summary by running a turn on the first participant.
   */
  private async generateSummary(
    summaryPrompt: string,
    context: DiscussionContext,
    signal: AbortSignal,
  ): Promise<string> {
    const firstAgentId = this.agentIds[0];
    if (firstAgentId === undefined) return '';

    try {
      const prompt = [
        summaryPrompt,
        '',
        'Full discussion transcript:',
        context.getTranscript(),
        '',
        'Please provide a concise summary of the discussion.',
      ].join('\n');

      return await this.subagentHost.runDiscussionTurn(
        firstAgentId,
        prompt,
        signal,
      );
    } catch {
      // Summary generation is best-effort
      return '';
    }
  }

  /**
   * Aggregate token usage across all participants.
   */
  private collectUsage(): TokenUsage {
    let total: TokenUsage | undefined;

    for (const agentId of this.agentIds) {
      const usage = this.subagentHost.getPersistentUsage(agentId);
      if (usage === undefined) continue;
      total = total === undefined ? { ...usage } : addUsage(total, usage);
    }

    return total ?? { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
  }

  /**
   * Destroy all persistent subagents.
   */
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