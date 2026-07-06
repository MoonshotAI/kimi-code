import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  randomUUID
} from 'node:crypto';
import {
  dirname,
  join
} from 'pathe';

import {
  Disposable,
} from "#/_base/di";
import { generateHeroSlug } from "#/_base/utils/hero-slug";
import { IAgentContextMemoryService, type ContextMessage } from '#/agent/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentTelemetryContextService, ITelemetryService } from '#/app/telemetry';
import { IAgentWireService, type IWireService } from '#/wire';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import type { ExecutableToolResult } from '#/agent/tool';
import { type ExitPlanModeInput } from '#/agent/plan/tools/exit-plan-mode';
import {
  IAgentPlanService,
  type PlanData,
  type PlanFilePath,
} from './plan';
import {
  PlanModel,
  planModeCancel,
  planModeEnter,
  planModeExit,
} from './planOps';
import PLAN_MODE_EXIT_REMINDER from './plan-mode-exit-reminder.md?raw';

const PLAN_MODE_DEDUP_MIN_TURNS = 2;
const PLAN_MODE_FULL_REFRESH_TURNS = 5;
const PLAN_MODE_INJECTION_VARIANT = 'plan_mode';

export class AgentPlanService extends Disposable implements IAgentPlanService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
    @IAgentWireService private readonly wire: IWireService,
  ) {
    super();

    this._register(this.wire.onRestored(() => this.restoreTelemetryMode()));

    let wasActive = false;
    this._register(
      dynamicInjector.register(PLAN_MODE_INJECTION_VARIANT, async ({ lastInjectedAt: injectedAt }) => {
        if (!this.isActive) {
          if (!wasActive) return undefined;
          wasActive = false;
          return PLAN_MODE_EXIT_REMINDER;
        }
        if (!wasActive) {
          wasActive = true;
          if (await this.hasCurrentPlanContent()) {
            return this.reentryReminder();
          }
          return this.fullReminder();
        }
        const variant = planModeReminderVariant(injectedAt, this.context.get());
        if (variant === 'full') return this.fullReminder();
        if (variant === 'sparse') return this.sparseReminder();
        return undefined;
      }),
    );
  }

  private get isActive(): boolean {
    return this.wire.getModel(PlanModel).active;
  }

  private currentPlanFilePath(): PlanFilePath {
    const state = this.wire.getModel(PlanModel);
    if (!state.active || state.id === undefined) return null;
    return state.planFilePath ?? this.planFilePathFor(state.id);
  }

  private restoreTelemetryMode(): void {
    // `wire.replay` rebuilds `PlanModel` silently, so the live telemetry
    // context (set on the enter/exit path) is not re-applied by replay. Re-derive
    // it here from the restored model so a resumed plan-mode session keeps
    // tagging telemetry with `mode: 'plan'` (mirroring the legacy restoreEnter).
    if (this.isActive) {
      this.telemetryContext.set({ mode: 'plan' });
    }
  }

  private createPlanId(): string {
    return generateHeroSlug(randomUUID(), new Set());
  }

  async enter(
    id = this.createPlanId(),
    createFile = false,
    emitStatus = true,
  ): Promise<void> {
    if (this.isActive) {
      throw new Error('Already in plan mode');
    }

    const planFilePath = this.planFilePathFor(id);
    this.wire.dispatch(planModeEnter({ id, planFilePath }));
    this.telemetryContext.set({ mode: 'plan' });

    try {
      await this.ensurePlanDirectory(planFilePath);
      if (createFile) {
        await this.writeEmptyPlanFile(planFilePath);
      }
    } catch (error) {
      this.cancel(id);
      throw error;
    }

    if (emitStatus) this.emitChanged();
  }

  cancel(id?: string): void {
    this.wire.dispatch(planModeCancel({ id }));
    this.telemetryContext.set({ mode: 'agent' });
    this.emitChanged();
  }

  async clear(): Promise<void> {
    const path = this.currentPlanFilePath();
    if (path === null) return;
    await this.writeEmptyPlanFile(path);
  }

  exit(id?: string): void {
    this.wire.dispatch(planModeExit({ id }));
    this.telemetryContext.set({ mode: 'agent' });
    this.emitChanged();
  }

  async status(): Promise<PlanData> {
    const state = this.wire.getModel(PlanModel);
    if (!state.active || state.id === undefined) return null;
    const path = state.planFilePath ?? this.planFilePathFor(state.id);
    let content = '';
    try {
      content = await this.hostFs.readText(this._planFilePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return {
      id: state.id,
      content,
      path,
    };
  }

  private planFilePathFor(id: string): string {
    return join(this.currentCwd(), 'plan', `${id}.md`);
  }

  private async enterPlanModeToolResult(): Promise<ExecutableToolResult> {
    if (this.isActive) {
      return {
        isError: true,
        output: 'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
      };
    }

    try {
      await this.enter();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enter plan mode.';
      return { isError: true, output: `Failed to enter plan mode: ${message}` };
    }

    this.trackTelemetry('plan_enter_resolved', { outcome: 'auto_approved' });

    return { output: enteredPlanModeMessage(this.currentPlanFilePath()) };
  }

  private async resolvePlanReviewDisplay(
    args: ExitPlanModeInput,
  ): Promise<ToolInputDisplay | undefined> {
    if (!this.isActive) return undefined;
    let data: PlanData;
    try {
      data = await this.status();
    } catch {
      return undefined;
    }
    if (data === null || data.content.trim().length === 0) return undefined;
    const display: ToolInputDisplay = {
      kind: 'plan_review',
      plan: data.content,
      path: data.path,
    };
    if (args.options !== undefined && args.options.length >= 2) {
      display.options = args.options;
    }
    return display;
  }

  private async exitPlanModeToolResult(input: ExitPlanModeInput): Promise<ExecutableToolResult> {
    if (!this.isActive) {
      return {
        isError: true,
        output:
          'ExitPlanMode can only be called while plan mode is active. Use EnterPlanMode (or /plan) first.',
      };
    }

    const resolvedPlan = await this.resolvePlan();
    if (!resolvedPlan.ok) return resolvedPlan.error;

    this.trackTelemetry('plan_submitted', {
      has_options: input.options !== undefined && input.options.length >= 2,
    });

    try {
      this.exit();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return { isError: true, output: `Failed to exit plan mode: ${message}` };
    }

    this.trackTelemetry('plan_resolved', { outcome: 'auto_approved' });

    return {
      isError: false,
      output: `Exited plan mode. ${formatPlanForOutput(resolvedPlan.plan, resolvedPlan.path)}`,
    };
  }

  private async resolvePlan(): Promise<ResolvePlanResult> {
    let data: PlanData;
    try {
      data = await this.status();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read plan file.';
      return {
        ok: false,
        error: { isError: true, output: `Failed to read plan file: ${message}` },
      };
    }

    if (data !== null && data.content.trim().length > 0) {
      return { ok: true, plan: data.content, path: data.path };
    }

    return {
      ok: false,
      error: {
        isError: true,
        output:
          this.currentPlanFilePath() === null
            ? 'No plan file found. Write the plan to the current plan file first, then call ExitPlanMode.'
            : `No plan file found. Write your plan to ${this.currentPlanFilePath()} first, then call ExitPlanMode.`,
      },
    };
  }

  private emitChanged(): void {
    this.wire.signal({ type: 'agent.status.updated', planMode: this.isActive });
  }

  private trackTelemetry(
    event: 'plan_enter_resolved' | 'plan_submitted' | 'plan_resolved',
    properties: Record<string, string | number | boolean | undefined>,
  ): void {
    this.telemetry.track(event, properties);
  }

  private async hasCurrentPlanContent(): Promise<boolean> {
    try {
      const data = await this.status();
      return data !== null && data.content.trim().length > 0;
    } catch {
      return false;
    }
  }

  private fullReminder(): string {
    return fullReminder(this.currentPlanFilePath());
  }

  private sparseReminder(): string {
    return sparseReminder(this.currentPlanFilePath());
  }

  private reentryReminder(): string {
    return reentryReminder(this.currentPlanFilePath());
  }

  private async writeEmptyPlanFile(path: string): Promise<void> {
    await this.ensurePlanDirectory(path);
    await this.hostFs.writeText(path, '');
  }

  private async ensurePlanDirectory(path: string): Promise<void> {
    await this.hostFs.mkdir(dirname(path), { recursive: true });
  }

  private currentCwd(): string {
    return this.profile.data().cwd ?? process.cwd();
  }
}

type PlanModeReminderVariant = 'full' | 'sparse';

type ResolvePlanResult =
  | { readonly ok: true; readonly plan: string; readonly path?: string | undefined }
  | { readonly ok: false; readonly error: ExecutableToolResult };

function planModeReminderVariant(
  injectedAt: number | null,
  history: readonly ContextMessage[],
): PlanModeReminderVariant | null {
  if (injectedAt === null) return 'full';
  let assistantTurnsSince = 0;
  for (let i = injectedAt + 1; i < history.length; i++) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.role === 'assistant') {
      assistantTurnsSince += 1;
      continue;
    }
    if (message.role === 'user') {
      return 'full';
    }
  }
  if (assistantTurnsSince >= PLAN_MODE_FULL_REFRESH_TURNS) return 'full';
  if (assistantTurnsSince >= PLAN_MODE_DEDUP_MIN_TURNS) return 'sparse';
  return null;
}

function withPlanFileFooter(body: string, planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) return body;
  return `${body}\n\nPlan file: ${planFilePath}`;
}

function fullReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return inlineFullReminder();
  }

  const body = `Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file) or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received.

Workflow:
  1. Understand - explore the codebase with Glob, Grep, Read.
  2. Design - converge on the best approach; consider trade-offs but aim for a single recommendation.
  3. Review - re-read key files to verify understanding.
  4. Write Plan - modify the plan file with Write or Edit. Use Write if the plan file does not exist yet.
  5. Exit - call ExitPlanMode for user approval.

## Handling multiple approaches
Keep it focused: at most 2-3 meaningfully different approaches. Do NOT pad with minor variations - if one approach is clearly superior, just propose that one.
When the best approach depends on user preferences, constraints, or context you don't have, use AskUserQuestion to clarify first. This helps you write a better, more targeted plan rather than dumping multiple options for the user to sort through.
When you do include multiple approaches in the plan, you MUST pass them as the \`options\` parameter when calling ExitPlanMode, so the user can select which approach to execute at approval time.
NEVER write multiple approaches in the plan and call ExitPlanMode without the \`options\` parameter - the user will only see the default approval controls with no way to choose a specific approach.

AskUserQuestion is for clarifying missing requirements or user preferences that affect the plan.
Never ask about plan approval via text or AskUserQuestion.
Your turn must end with either AskUserQuestion (to clarify requirements or preferences) or ExitPlanMode (to request plan approval). Do NOT end your turn any other way.
Do NOT use AskUserQuestion to ask about plan approval or reference "the plan" - the user cannot see the plan until you call ExitPlanMode.`;
  return withPlanFileFooter(body, planFilePath);
}

function sparseReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return inlineSparseReminder();
  }

  const body =
    'Plan mode still active (see full instructions earlier). Prefer read-only tools except the current plan file. Use Write or Edit to modify the plan file. If it does not exist yet, create it with Write first. Use Bash only when needed; Bash follows the normal permission mode and rules. Use AskUserQuestion to clarify user preferences when it helps you write a better plan. If the plan has multiple approaches, pass options to ExitPlanMode so the user can choose. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for approval). Never ask about plan approval via text or AskUserQuestion.';
  return withPlanFileFooter(body, planFilePath);
}

function reentryReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return inlineReentryReminder();
  }

  const body = `Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file) or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received.

## Re-entering Plan Mode
A plan file from a previous planning session already exists.
Before proceeding:
  1. Read the existing plan file to understand what was previously planned.
  2. Evaluate the user's current request against that plan.
  3. If different task: replace the old plan with a fresh one. If same task: update the existing plan.
  4. You may use Write or Edit to modify the plan file. If the file does not exist yet, create it with Write first.
  5. Use AskUserQuestion to clarify missing requirements or user preferences that affect the plan.
  6. Always edit the plan file before calling ExitPlanMode.

Your turn must end with either AskUserQuestion (to clarify requirements) or ExitPlanMode (to request plan approval).`;
  return withPlanFileFooter(body, planFilePath);
}

function inlineFullReminder(): string {
  return `Plan mode is active. You MUST NOT make any edits or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received.

Workflow:
  1. Understand - explore the codebase with Glob, Grep, Read.
  2. Design - converge on the best approach; consider trade-offs but aim for a single recommendation.
  3. Review - re-read key files to verify understanding.
  4. Wait for the host to provide a plan file path, write the plan there, then call ExitPlanMode.

## Handling multiple approaches
Keep it focused: at most 2-3 meaningfully different approaches. Do NOT pad with minor variations - if one approach is clearly superior, just propose that one.
When the best approach depends on user preferences, constraints, or context you don't have, use AskUserQuestion to clarify first.
When you do include multiple approaches in the plan, you MUST pass them as the \`options\` parameter when calling ExitPlanMode, so the user can select which approach to execute at approval time.

AskUserQuestion is for clarifying missing requirements or user preferences that affect the plan.
Never ask about plan approval via text or AskUserQuestion.
Your turn must end with either AskUserQuestion (to clarify requirements or preferences) or ExitPlanMode (to request plan approval). Do NOT end your turn any other way.`;
}

function inlineSparseReminder(): string {
  return 'Plan mode still active (see full instructions earlier). Read-only; no plan file path is available in this host. Wait for the host to provide a plan file path before calling ExitPlanMode. Use AskUserQuestion to clarify user preferences when it helps you write a better plan. If the plan has multiple approaches, pass options to ExitPlanMode so the user can choose. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for approval).';
}

function inlineReentryReminder(): string {
  return `Plan mode is active. You MUST NOT make any edits or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received.

## Re-entering Plan Mode
No plan file path is available in this host.
Before proceeding:
  1. Re-evaluate the user request and any existing conversation context.
  2. Use AskUserQuestion to clarify missing requirements or user preferences that affect the plan.
  3. Wait for the host to provide a plan file path, write the revised plan there, then call ExitPlanMode.

Your turn must end with either AskUserQuestion (to clarify requirements) or ExitPlanMode (to request plan approval).`;
}

function enteredPlanModeMessage(planPath: string | null): string {
  if (planPath === null) {
    return [
      'Plan mode is now active. Your workflow:',
      '',
      '1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.',
      '2. Design a concrete, step-by-step plan.',
      '3. Wait for the host to provide a plan file path before calling ExitPlanMode.',
      '',
      'Do NOT use Write or Edit while plan mode is active in this host; no plan file path is available.',
      'Use Bash only when needed; Bash follows the normal permission mode and rules.',
    ].join('\n');
  }

  return [
    'Plan mode is now active. Your workflow:',
    '',
    `Plan file: ${planPath}`,
    '',
    '1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.',
    '2. Design a concrete, step-by-step plan.',
    '3. Write the plan to the plan file with Write or Edit.',
    '4. When the plan is ready, call ExitPlanMode for user approval.',
    '',
    'Do NOT edit files other than the plan file while plan mode is active.',
    'Use Bash only when needed; Bash follows the normal permission mode and rules.',
  ].join('\n');
}

function formatPlanForOutput(plan: string, path: string | undefined): string {
  const savedTo = path !== undefined ? `Plan saved to: ${path}\n\n` : '';
  return `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${plan}`;
}

function isMissingFileError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

export { AgentPlanService as Plan };

registerScopedService(
  LifecycleScope.Agent,
  IAgentPlanService,
  AgentPlanService,
  InstantiationType.Delayed,
  'plan',
);
