/**
 * Detects when a turn is spinning without making real progress.
 *
 * Progress is measured by looking at external, observable state rather than
 * interpreting model outputs:
 *
 *   - Information gain: successful tool outputs that are non-trivial and have
 *     not been seen before in this turn.
 *   - External state change: git working tree, background task lifecycle, or
 *     other host-provided snapshots.
 *
 * When a configurable number of consecutive steps pass without progress, the
 * detector reports that the turn has stalled. The host can then force the model
 * into text-only mode instead of letting it continue emitting placeholder tool
 * calls.
 */

import { createHash } from 'node:crypto';

import type { LoopRecordedEvent, LoopToolCallEvent, LoopToolResultEvent } from '../../loop/events';

const PROGRESS_TOOLS = new Set(['Edit', 'Write']);

export interface ProgressSnapshot {
  /**
   * `git status --porcelain` output. Empty when git is unavailable or the tree
   * is clean. Changes when the working tree actually changes.
   */
  readonly gitStatus: string;
  /**
   * Snapshot of active/terminal background tasks. Changes when tasks are
   * created, complete, fail, or are stopped.
   */
  readonly backgroundTasks: string;
}

export type TakeProgressSnapshot = () => Promise<ProgressSnapshot> | ProgressSnapshot;

export interface ProgressDetectorOptions {
  /** Called once per step to capture external world state. */
  readonly takeSnapshot: TakeProgressSnapshot;
  /**
   * Minimum successful output length to count as information gain.
   * Outputs shorter than this are treated as trivial/no-op responses.
   */
  readonly minInfoGainLength?: number | undefined;
}

const DEFAULT_MIN_INFO_GAIN_LENGTH = 60;

/**
 * Tracks whether a turn is still advancing.
 *
 * The detector is intentionally stateful per-turn: it accumulates seen output
 * hashes and the last external snapshot, and reports how many consecutive steps
 * have passed without any progress signal.
 */
export class ProgressDetector {
  private readonly takeSnapshot: TakeProgressSnapshot;
  private readonly minInfoGainLength: number;
  private readonly seenOutputHashes = new Set<string>();
  private previousSnapshot?: ProgressSnapshot;
  private currentStepEvents: LoopRecordedEvent[] = [];
  private readonly toolCallNames = new Map<string, string>();
  private lastProgressStep = 0;

  constructor(options: ProgressDetectorOptions) {
    this.takeSnapshot = options.takeSnapshot;
    this.minInfoGainLength = options.minInfoGainLength ?? DEFAULT_MIN_INFO_GAIN_LENGTH;
  }

  /** Called for every recorded loop event so the detector can observe results. */
  onLoopEvent(event: LoopRecordedEvent): void {
    this.currentStepEvents.push(event);
    if (event.type === 'tool.call') {
      const call = event as LoopToolCallEvent;
      this.toolCallNames.set(call.toolCallId, call.name);
    }
  }

  /**
   * Evaluates the events collected since the last call and reports whether this
   * step made progress. Resets the per-step event buffer.
   */
  async recordStep(stepNumber: number): Promise<boolean> {
    const snapshot = await this.takeSnapshot();
    const stateChanged = this.hasExternalStateChanged(snapshot);
    this.previousSnapshot = snapshot;

    const infoGained = this.hasInformationGain();
    this.currentStepEvents = [];

    const progress = stateChanged || infoGained;
    if (progress) {
      this.lastProgressStep = stepNumber;
    }
    return progress;
  }

  /** Number of consecutive steps since the last progress signal. */
  stepsSinceLastProgress(currentStep: number): number {
    return currentStep - this.lastProgressStep;
  }

  private hasExternalStateChanged(current: ProgressSnapshot): boolean {
    if (this.previousSnapshot === undefined) {
      return false; // First step has no previous snapshot to compare against.
    }
    return (
      this.previousSnapshot.gitStatus !== current.gitStatus ||
      this.previousSnapshot.backgroundTasks !== current.backgroundTasks
    );
  }

  private hasInformationGain(): boolean {
    for (const event of this.currentStepEvents) {
      if (event.type !== 'tool.result') {
        continue;
      }
      const resultEvent = event as LoopToolResultEvent;
      const result = resultEvent.result;
      if (result.isError === true) {
        continue;
      }
      // Successful writes/edits are real progress even when their output is
      // short, because they change file contents. git status --porcelain does
      // not capture repeated edits to an already-dirty file.
      const toolName = this.toolCallNames.get(resultEvent.toolCallId);
      if (toolName !== undefined && PROGRESS_TOOLS.has(toolName)) {
        return true;
      }
      const text = extractOutputText(result.output);
      if (text.length < this.minInfoGainLength) {
        continue;
      }
      const hash = hashString(text);
      if (!this.seenOutputHashes.has(hash)) {
        this.seenOutputHashes.add(hash);
        return true;
      }
    }
    return false;
  }
}

function extractOutputText(output: string | readonly { readonly type: string; readonly text?: string }[]): string {
  if (typeof output === 'string') {
    return output;
  }
  return output
    .filter((part): part is { readonly type: string; readonly text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function hashString(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
