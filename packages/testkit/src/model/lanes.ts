import { TIMEOUTS } from '#/fixtures/timeouts';
import type { RequestFacts } from '#/model/record';
import type { ModelRequest, Step, UnscriptedPolicy, WaitOptions } from '#/model/types';
import { waitForModelEvent } from '#/model/wait';

export const BUILT_IN_LANES = ['main', 'subagent', 'compaction', 'side'] as const;

export type BuiltInLaneName = (typeof BUILT_IN_LANES)[number];

export type LaneMatcher = (request: RequestFacts) => boolean;

export interface Lane {
  readonly name: string;
  readonly pending: number;
  script(...steps: readonly Step[]): Lane;
  unscripted(policy: UnscriptedPolicy): Lane;
  clear(): Lane;
  requests(): readonly ModelRequest[];
  waitForRequest(laneIndex: number, options?: WaitOptions): Promise<ModelRequest>;
}

export class LaneState implements Lane {
  private readonly queue: Step[] = [];
  private readonly recorded: ModelRequest[] = [];
  private readonly arrivalListeners = new Set<() => void>();

  constructor(
    readonly name: string,
    private policy: UnscriptedPolicy,
    private readonly onScripted: (step: Step) => void,
    private readonly closing: AbortSignal,
    readonly matcher?: LaneMatcher,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  get unscriptedPolicy(): UnscriptedPolicy {
    return this.policy;
  }

  script(...steps: readonly Step[]): Lane {
    for (const step of steps) this.onScripted(step);
    this.queue.push(...steps);
    return this;
  }

  unscripted(policy: UnscriptedPolicy): Lane {
    this.policy = policy;
    return this;
  }

  clear(): Lane {
    this.queue.length = 0;
    return this;
  }

  requests(): readonly ModelRequest[] {
    return this.recorded;
  }

  waitForRequest(laneIndex: number, options: WaitOptions = {}): Promise<ModelRequest> {
    const existing = this.recorded[laneIndex];
    if (existing !== undefined) return Promise.resolve(existing);
    return waitForModelEvent<ModelRequest>(
      this.closing,
      (settle) => {
        const check = (): void => {
          const arrived = this.recorded[laneIndex];
          if (arrived !== undefined) settle(arrived);
        };
        this.arrivalListeners.add(check);
        return () => this.arrivalListeners.delete(check);
      },
      {
        timeoutMs: options.timeoutMs ?? TIMEOUTS.request,
        describe: () => `request ${laneIndex} on lane ${JSON.stringify(this.name)} (received ${this.recorded.length})`,
      },
    );
  }

  take(): Step | undefined {
    return this.queue.shift();
  }

  remaining(): readonly Step[] {
    return this.queue;
  }

  record(request: ModelRequest): void {
    this.recorded.push(request);
    for (const notify of this.arrivalListeners) notify();
  }

  get nextIndex(): number {
    return this.recorded.length;
  }
}

export function promptCacheRoleOf(request: RequestFacts): BuiltInLaneName {
  const agentRole = request.metadata?.agentRole;
  return agentRole !== undefined && agentRole !== 'main' ? 'subagent' : builtInLaneOf(request);
}

export function builtInLaneOf(request: RequestFacts): BuiltInLaneName {
  const metadata = request.metadata;
  if (metadata !== undefined) {
    if (metadata.stepReason === 'compact') return 'compaction';
    if (metadata.agentRole !== undefined && metadata.agentRole !== 'main') return 'subagent';
    return 'main';
  }
  return request.view.tools.length === 0 ? 'side' : 'main';
}
