/**
 * `PromptSession` backed by an agent-core-v2 session + main agent.
 *
 * Created by {@link V2PromptHarness}. Resolves v2 services off the session /
 * main-agent scopes and adapts them to the narrow print-mode surface. The
 * event stream is adapted in {@link subscribeAgentEvents} (see adapt-events.ts).
 */

import {
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptLegacyService,
  IAgentTaskService,
  IConfigService,
  IEventBus,
  ISessionLegacyService,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type {
  ApprovalHandler,
  CreateGoalInput,
  Event,
  GoalSnapshot,
  GoalToolResult,
  PermissionMode,
  PromptInput,
  QuestionHandler,
  SessionStatus,
  Unsubscribe,
} from '@moonshot-ai/kimi-code-sdk';

import type { PromptSession } from '../prompt-session';
import { subscribeAgentEvents } from './adapt-events';

const DEFAULT_PRINT_WAIT_CEILING_S = 3600;
const TASK_CONFIG_SECTION = 'task';
const LEGACY_BACKGROUND_CONFIG_SECTION = 'background';

interface TaskPrintWaitConfig {
  readonly printWaitCeilingS?: number;
}

export interface V2SessionContext {
  readonly core: Scope;
  readonly session: ISessionScopeHandle;
  readonly agent: IAgentScopeHandle;
}

export class V2Session implements PromptSession {
  readonly id: string;
  readonly workDir: string;

  private readonly core: Scope;
  private readonly session: ISessionScopeHandle;
  private readonly agent: IAgentScopeHandle;

  constructor(context: V2SessionContext) {
    this.core = context.core;
    this.session = context.session;
    this.agent = context.agent;
    this.id = context.session.id;
    this.workDir = resolveWorkDir(context.session);
  }

  async getStatus(): Promise<SessionStatus> {
    const raw = await this.core.accessor.get(ISessionLegacyService).status(this.id);
    return {
      model: raw.model === '' ? undefined : raw.model,
      thinkingEffort: raw.thinking_level ?? '',
      permission: raw.permission as PermissionMode,
      planMode: raw.plan_mode,
      swarmMode: raw.swarm_mode,
      contextTokens: raw.context_tokens,
      maxContextTokens: raw.max_context_tokens,
      contextUsage: raw.context_usage,
    };
  }

  async setModel(model: string): Promise<void> {
    await this.agent.accessor.get(IAgentProfileService).setModel(model);
  }

  async setPermission(mode: PermissionMode): Promise<void> {
    this.agent.accessor
      .get(IAgentPermissionModeService)
      .setMode(mode as 'yolo' | 'manual' | 'auto');
  }

  setApprovalHandler(_handler: ApprovalHandler | undefined): void {
    // Print mode forces the main agent into 'auto' permission (see
    // forcePromptPermission), so the v2 policy layer auto-approves normal
    // tools and denies AskUserQuestion before any interaction is parked.
    // Subagents inherit the session workspace; if a future scenario parks an
    // approval outside 'auto', a session-wide `ISessionInteractionService`
    // backstop (auto-decide / dismiss) would be added here.
  }

  setQuestionHandler(_handler: QuestionHandler | undefined): void {
    // See setApprovalHandler — 'auto' mode denies the AskUserQuestion tool at
    // the policy layer, so no question interaction is created in print mode.
  }

  onEvent(listener: (event: Event) => void): Unsubscribe {
    const eventBus = this.agent.accessor.get(IEventBus);
    return subscribeAgentEvents(eventBus, this.id, this.agent.id, listener);
  }

  async prompt(input: string | PromptInput): Promise<void> {
    const content = normalizePromptInput(input);
    await this.agent.accessor.get(IAgentPromptLegacyService).submit({ content });
  }

  async waitForBackgroundTasksOnPrint(): Promise<void> {
    // Drain background tasks (background bash and background subagents) spawned
    // during the turn before a `kimi -p` run exits. `-p` must be able to run
    // long tasks to completion, so we wait until every active task across every
    // agent reaches a terminal state — bounded only by `[task]/[background]
    // print_wait_ceiling_s` (default 1h) so a genuinely wedged task cannot keep
    // the process alive forever.
    //
    // Tasks are re-enumerated each round: a subagent may fan out new background
    // tasks after a previous enumeration, and a single pass could return while
    // those later tasks are still running. Terminal notifications are suppressed
    // for each task while we wait, so a task completing cannot `turn.steer` the
    // (already finished) main agent into launching a new turn.
    const deadline = Date.now() + this.readPrintWaitCeilingMs();
    const seen = new Set<string>();
    const allWaiters: Promise<unknown>[] = [];
    while (Date.now() < deadline) {
      const batch: Promise<unknown>[] = [];
      const suppressions: Promise<void>[] = [];
      let activeCount = 0;
      for (const handle of this.session.accessor.get(IAgentLifecycleService).list()) {
        const taskService = handle.accessor.get(IAgentTaskService);
        for (const task of taskService.list(true)) {
          activeCount++;
          if (seen.has(task.taskId)) continue;
          seen.add(task.taskId);
          suppressions.push(taskService.suppressTerminalNotification(task.taskId));
          const remaining = Math.max(1, deadline - Date.now());
          const waiter = taskService.wait(task.taskId, remaining);
          batch.push(waiter);
          allWaiters.push(waiter);
        }
      }
      if (suppressions.length > 0) await Promise.all(suppressions);
      if (activeCount === 0 || batch.length === 0) break;
      await Promise.all(batch);
    }
    if (allWaiters.length > 0) await Promise.all(allWaiters);
  }

  private readPrintWaitCeilingMs(): number {
    const config = this.core.accessor.get(IConfigService);
    const section =
      config.get<TaskPrintWaitConfig>(TASK_CONFIG_SECTION) ??
      config.get<TaskPrintWaitConfig>(LEGACY_BACKGROUND_CONFIG_SECTION);
    const ceilingS = section?.printWaitCeilingS;
    if (typeof ceilingS === 'number' && Number.isFinite(ceilingS) && ceilingS > 0) {
      return ceilingS * 1000;
    }
    return DEFAULT_PRINT_WAIT_CEILING_S * 1000;
  }

  async createGoal(input: CreateGoalInput): Promise<GoalSnapshot> {
    return (await this.agent.accessor
      .get(IAgentGoalService)
      .createGoal(input)) as unknown as GoalSnapshot;
  }

  async getGoal(): Promise<GoalToolResult> {
    return this.agent.accessor.get(IAgentGoalService).getGoal() as unknown as GoalToolResult;
  }
}

function resolveWorkDir(session: ISessionScopeHandle): string {
  // The session scope does not eagerly expose workDir; the index summary does
  // (cwd). We read it lazily from the session context if available, else ''.
  // Print mode only uses workDir for display / resume-hint, both of which come
  // from the harness's createSession input, so this is a best-effort fallback.
  const maybe = (session as { readonly workDir?: string }).workDir;
  return maybe ?? '';
}

function normalizePromptInput(
  input: string | PromptInput,
): Parameters<IAgentPromptLegacyService['submit']>[0]['content'] {
  if (typeof input === 'string') {
    if (input.trim().length === 0) {
      throw new Error('Prompt input cannot be empty');
    }
    return [{ type: 'text', text: input }];
  }
  if (input.length === 0) {
    throw new Error('Prompt input cannot be empty');
  }
  return [...input] as Parameters<IAgentPromptLegacyService['submit']>[0]['content'];
}
