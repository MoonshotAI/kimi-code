import { mapWithConcurrency } from './concurrency';
import { parsePlan, parseReviseDecision } from './parse';
import {
  ALLOWED_WORKER_TOOLS,
  DEFAULT_WORKER_TOOLS,
  PLANNER_SYSTEM_PROMPT,
  REVISER_SYSTEM_PROMPT,
  SYNTHESIZER_SYSTEM_PROMPT,
  renderPlannerPrompt,
  renderPlannerRetryPrompt,
  renderReviseSubtaskPrompt,
  renderSynthesizerPrompt,
} from './prompts';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_WAVES,
  type ReviseDecision,
  type Subtask,
  type SwarmCoordinatorDeps,
  type SwarmPlan,
  type SwarmProgress,
} from './types';

export class SwarmCoordinator {
  constructor(private readonly deps: SwarmCoordinatorDeps) {}

  private progress(text: string): void {
    this.deps.onProgress?.(text);
  }

  private emit(progress: SwarmProgress): void {
    this.deps.onProgressCustom?.(progress);
  }

  async run(rootTask: string): Promise<string> {
    this.deps.signal.throwIfAborted();
    this.progress('Planning subtasks…');
    const plan = await this.decompose(rootTask);
    this.progress(`Planned ${String(plan.subtasks.length)} subtasks`);
    this.emit({ phase: 'planned', total: plan.subtasks.length });

    await this.runWithRetries(plan);

    this.emit({ phase: 'synthesizing' });
    this.progress('Synthesizing results…');
    const result = await this.deps.spawnSubagent({
      profileName: 'swarm-synthesizer',
      systemPrompt: SYNTHESIZER_SYSTEM_PROMPT,
      tools: [],
      prompt: renderSynthesizerPrompt(plan),
      description: 'Swarm synthesizer',
      signal: this.deps.signal,
    });
    const succeeded = plan.subtasks.filter((s) => s.status === 'done').length;
    const failed = plan.subtasks.filter((s) => s.status === 'failed').length;
    const dropped = plan.subtasks.filter((s) => s.status === 'dropped').length;
    this.emit({ phase: 'done', succeeded, failed, dropped });
    return result.result;
  }

  private async decompose(rootTask: string): Promise<SwarmPlan> {
    const first = await this.deps.spawnSubagent({
      profileName: 'swarm-planner',
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      tools: [],
      prompt: renderPlannerPrompt(rootTask),
      description: 'Swarm planner',
      signal: this.deps.signal,
    });
    const plan = parsePlan(rootTask, first.result);
    if (plan !== null) return plan;

    const retry = await this.deps.spawnSubagent({
      profileName: 'swarm-planner',
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      tools: [],
      prompt: renderPlannerRetryPrompt(rootTask, first.result),
      description: 'Swarm planner (retry)',
      signal: this.deps.signal,
    });
    const retried = parsePlan(rootTask, retry.result);
    if (retried !== null) return retried;

    throw new Error('Swarm planner failed to produce a valid plan after one retry');
  }

  /**
   * Wave loop with bounded failure recovery. Each iteration runs the pending
   * subtasks; then, for every subtask still 'failed', either force-drops it
   * (attempts exhausted) or asks the reviser how to recover it and re-queues it
   * for the next wave. Terminates when no subtasks remain pending, or when the
   * {@link DEFAULT_MAX_WAVES} safety bound is hit.
   */
  private async runWithRetries(plan: SwarmPlan): Promise<void> {
    const maxAttempts = this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const maxWaves = this.deps.maxWaves ?? DEFAULT_MAX_WAVES;

    for (let wave = 0; wave < maxWaves; wave += 1) {
      const pending = plan.subtasks.filter((s) => s.status === 'pending');
      if (pending.length === 0) break;

      await this.runWave(pending);

      for (const st of plan.subtasks) {
        if (st.status !== 'failed') continue;
        if (st.attempts >= maxAttempts) {
          this.forceDrop(st, `attempts exhausted (${String(st.attempts)})`);
          continue;
        }
        const decision = await this.reviseSubtask(st);
        this.emit({
          phase: 'revising',
          subtaskId: st.id,
          // Capture the role BEFORE applyDecision so a `reassign` still
          // correlates to the existing dashboard row keyed by the old role.
          role: st.role,
          decision: decision.kind,
          // For a reassign, carry the NEW role too so the dashboard can re-key
          // the existing old-role row instead of stranding it in `retrying`.
          ...(decision.kind === 'reassign' ? { newRole: decision.role } : {}),
          attempt: st.attempts,
        });
        this.applyDecision(st, decision);
      }
    }

    // Safety net: anything still pending after the wave bound is dropped so the
    // loop is guaranteed to terminate and the subtask surfaces as a gap.
    for (const st of plan.subtasks) {
      if (st.status === 'pending' || st.status === 'failed') {
        this.forceDrop(st, 'recovery wave limit reached');
      }
    }
  }

  /** Run a SUBSET of subtasks (the pending ones passed in) concurrently. */
  private async runWave(subtasks: Subtask[]): Promise<void> {
    const limit = this.deps.maxConcurrency ?? 4;
    await mapWithConcurrency(subtasks, limit, async (st) => {
      this.deps.signal.throwIfAborted();
      st.status = 'running';
      st.attempts += 1;
      this.progress(`▸ ${st.role}: started`);
      try {
        const out = await this.deps.spawnSubagent({
          profileName: `swarm:${st.role}`,
          systemPrompt: st.systemPrompt,
          tools: (st.toolAllowlist ?? DEFAULT_WORKER_TOOLS).filter((t) =>
            ALLOWED_WORKER_TOOLS.includes(t),
          ),
          prompt: st.prompt,
          description: st.role,
          signal: this.deps.signal,
        });
        st.result = out.result;
        st.status = 'done';
        this.progress(`✓ ${st.role}: done`);
      } catch (err) {
        // A genuine swarm-wide cancel must propagate (and must NOT be revised).
        if (this.deps.signal.aborted) throw err;
        st.status = 'failed';
        st.error = err instanceof Error ? err.message : String(err);
        this.progress(`✗ ${st.role}: failed (${st.error})`);
      }
    });
  }

  /**
   * Ask a reviser subagent how to recover one failed subtask. On a malformed
   * response we conservatively drop (rather than burn an attempt on a confused
   * reviser).
   */
  private async reviseSubtask(st: Subtask): Promise<ReviseDecision> {
    const out = await this.deps.spawnSubagent({
      profileName: 'swarm-reviser',
      systemPrompt: REVISER_SYSTEM_PROMPT,
      tools: [],
      prompt: renderReviseSubtaskPrompt(st, st.error),
      description: `Swarm reviser (${st.role})`,
      signal: this.deps.signal,
    });
    return (
      parseReviseDecision(out.result) ?? {
        kind: 'drop',
        reason: 'reviser produced no valid decision',
      }
    );
  }

  /** Apply a reviser decision in place, re-queueing the subtask unless dropped. */
  private applyDecision(st: Subtask, decision: ReviseDecision): void {
    switch (decision.kind) {
      case 'retry':
        st.status = 'pending';
        return;
      case 'regenerate':
        st.prompt = decision.prompt;
        st.status = 'pending';
        return;
      case 'reassign':
        st.role = decision.role;
        st.systemPrompt = decision.systemPrompt;
        st.toolAllowlist = decision.toolAllowlist;
        st.status = 'pending';
        return;
      case 'drop':
        this.forceDrop(st, decision.reason);
        return;
    }
  }

  /** Mark a subtask dropped, record the reason, and emit a 'dropped' event. */
  private forceDrop(st: Subtask, reason: string): void {
    st.status = 'dropped';
    st.error = st.error === undefined ? `dropped: ${reason}` : `${st.error} (dropped: ${reason})`;
    this.progress(`x ${st.role}: dropped (${reason})`);
    this.emit({ phase: 'dropped', subtaskId: st.id, role: st.role, reason });
  }
}
