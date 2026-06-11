import type {
  RunSubagentOptions,
  SpawnSubagentOptions,
  SubagentHandle,
} from '../session/subagent-host';
import type { ReviewAssignment, ReviewProgressStatus } from './types';
import type { SessionReviewRuntime } from './runtime';

export interface ReviewWorkerDriverOptions {
  readonly runtime: SessionReviewRuntime;
  readonly launcher: ReviewWorkerLauncher;
  readonly assignment: ReviewAssignment;
  readonly profileName: 'reviewer' | 'reconciliator';
  readonly prompt: string;
  readonly description: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly runInBackground?: boolean;
  readonly signal: AbortSignal;
  readonly maxNonProgressContinuations?: number;
}

export interface ReviewWorkerLauncher {
  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle>;
  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
}

export interface ReviewWorkerDriverResult {
  readonly agentId: string;
  readonly status: ReviewProgressStatus;
  readonly summary?: string;
}

interface ReviewWorkerAudit {
  readonly status: ReviewProgressStatus;
  readonly summary?: string;
  readonly blocker?: string;
  readonly missingCoverage: readonly string[];
  readonly unreconciledComments: readonly string[];
  readonly signature: string;
}

const DEFAULT_MAX_NON_PROGRESS_CONTINUATIONS = 3;

export class ReviewWorkerDriver {
  constructor(private readonly options: ReviewWorkerDriverOptions) {}

  async run(): Promise<ReviewWorkerDriverResult> {
    const review = this.options.runtime.createAgentFacade(this.options.assignment.id);
    let handle = await this.options.launcher.spawn({
      profileName: this.options.profileName,
      parentToolCallId: this.options.parentToolCallId,
      parentToolCallUuid: this.options.parentToolCallUuid,
      prompt: this.options.prompt,
      description: this.options.description,
      runInBackground: this.options.runInBackground ?? false,
      signal: this.options.signal,
      review,
    });

    let previousSignature: string | undefined;
    let nonProgressContinuations = 0;
    const maxNonProgressContinuations =
      this.options.maxNonProgressContinuations ?? DEFAULT_MAX_NON_PROGRESS_CONTINUATIONS;

    while (true) {
      await handle.completion;
      const audit = this.audit();
      if (audit.status === 'complete' || audit.status === 'blocked') {
        return {
          agentId: handle.agentId,
          status: audit.status,
          summary: audit.summary ?? audit.blocker,
        };
      }

      if (audit.signature === previousSignature) {
        nonProgressContinuations += 1;
      } else {
        previousSignature = audit.signature;
        nonProgressContinuations = 0;
      }

      if (nonProgressContinuations >= maxNonProgressContinuations) {
        throw new Error(
          `Review worker ${this.options.assignment.id} made no progress after ${String(nonProgressContinuations)} continuations.`,
        );
      }

      handle = await this.options.launcher.resume(handle.agentId, {
        parentToolCallId: this.options.parentToolCallId,
        parentToolCallUuid: this.options.parentToolCallUuid,
        prompt: continuationPrompt(audit),
        description: this.options.description,
        runInBackground: this.options.runInBackground ?? false,
        signal: this.options.signal,
      });
    }
  }

  private audit(): ReviewWorkerAudit {
    const progress = this.options.runtime.getProgress(this.options.assignment.id);
    const missingCoverage = this.options.runtime
      .missingCoverage(this.options.assignment.id)
      .map((item) => `${item.path} (${item.required})`);
    const unreconciledComments = this.options.runtime.missingReconciliation(this.options.assignment.id);
    const status = progress?.status ?? 'active';
    const signature = JSON.stringify({
      status,
      missingCoverage,
      unreconciledComments,
      comments: this.options.runtime.getComments().length,
      merged: this.options.runtime.getMergedComments().length,
      dismissed: this.options.runtime.getDismissedComments().length,
    });
    return {
      status,
      summary: progress?.summary,
      blocker: progress?.blocker,
      missingCoverage,
      unreconciledComments,
      signature,
    };
  }
}

function continuationPrompt(audit: ReviewWorkerAudit): string {
  const lines = [
    'Continue the review assignment. It is not finished yet.',
    `Current status: ${audit.status}.`,
  ];
  if (audit.summary !== undefined) lines.push(`Current summary: ${audit.summary}`);
  if (audit.blocker !== undefined) lines.push(`Current blocker: ${audit.blocker}`);
  if (audit.missingCoverage.length > 0) {
    lines.push(`Missing required coverage: ${audit.missingCoverage.join(', ')}.`);
  } else if (audit.unreconciledComments.length > 0) {
    lines.push(`Unreconciled source comments: ${audit.unreconciledComments.join(', ')}.`);
  } else {
    lines.push('Required coverage is satisfied, but progress is not marked complete.');
  }
  lines.push(
    'Read any missing coverage, add or reconcile comments as needed, then call UpdateProgress with `complete` or `blocked`.',
  );
  return lines.join('\n');
}
