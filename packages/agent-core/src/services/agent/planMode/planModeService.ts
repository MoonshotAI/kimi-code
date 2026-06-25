import { randomUUID } from 'node:crypto';
import { dirname, join } from 'pathe';

import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
} from '../../../di';
import type { ExecutableToolResult } from '../../../loop';
import type { ToolInputDisplay } from '../../../tools/display';
import ENTER_PLAN_MODE_DESCRIPTION from '../../../tools/builtin/planning/enter-plan-mode.md?raw';
import { EnterPlanModeInputSchema } from '../../../tools/builtin/planning/enter-plan-mode';
import EXIT_PLAN_MODE_DESCRIPTION from '../../../tools/builtin/planning/exit-plan-mode.md?raw';
import {
  ExitPlanModeInputSchema,
  type ExitPlanModeInput,
} from '../../../tools/builtin/planning/exit-plan-mode';
import { toInputJsonSchema } from '../../../tools/support/input-schema';
import { generateHeroSlug } from '../../../utils/hero-slug';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IDynamicInjector } from '../dynamicInjector/dynamicInjector';
import { IEventBus } from '../eventBus/eventBus';
import { IKaosService } from '../kaos/kaos';
import { IProfileService } from '../profile/profile';
import { IReplayBuilderService } from '../replayBuilder/replayBuilder';
import { ITelemetryService } from '../telemetry/telemetry';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import type { ContextMessage } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IPlanModeService,
  type PlanData,
  type PlanFilePath,
} from './planMode';
import PLAN_MODE_EXIT_REMINDER from './plan-mode-exit-reminder.md?raw';

const PLAN_MODE_DEDUP_MIN_TURNS = 2;
const PLAN_MODE_FULL_REFRESH_TURNS = 5;
const PLAN_MODE_INJECTION_VARIANT = 'plan_mode';

export class PlanModeService extends Disposable implements IPlanModeService {
  declare readonly _serviceBrand: undefined;

  private _active = false;
  private planId: string | null = null;
  private _planFilePath: PlanFilePath = null;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @IKaosService private readonly kaosService: IKaosService,
    @IProfileService private readonly profile: IProfileService,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
    @IToolRegistry toolRegistry: IToolRegistry,
    @IDynamicInjector dynamicInjector: IDynamicInjector,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this._register(
      wireRecord.register('plan_mode.enter', ({ id }) => {
        this.restoreEnter({ id });
      }),
    );
    this._register(
      wireRecord.register('plan_mode.cancel', () => {
        this.replayBuilder.push({ type: 'plan_updated', enabled: false });
        this.applyInactive();
      }),
    );
    this._register(
      wireRecord.register('plan_mode.exit', () => {
        this.replayBuilder.push({ type: 'plan_updated', enabled: false });
        this.applyInactive();
      }),
    );

    this._register(
      toolRegistry.register({
        name: 'EnterPlanMode',
        description: ENTER_PLAN_MODE_DESCRIPTION,
        parameters: toInputJsonSchema(EnterPlanModeInputSchema),
        resolveExecution: () => {
          return {
            description: 'Requesting to enter plan mode',
            approvalRule: 'EnterPlanMode',
            execute: async () => this.enterPlanModeToolResult(),
          };
        },
      }),
    );
    this._register(
      toolRegistry.register({
        name: 'ExitPlanMode',
        description: EXIT_PLAN_MODE_DESCRIPTION,
        parameters: toInputJsonSchema(ExitPlanModeInputSchema),
        resolveExecution: async (args: unknown) => {
          const input = args as ExitPlanModeInput;
          return {
            description: 'Presenting plan and exiting plan mode',
            display: await this.resolvePlanReviewDisplay(input),
            approvalRule: 'ExitPlanMode',
            execute: async () => this.exitPlanModeToolResult(input),
          };
        },
      }),
    );

    let wasActive = false;
    this._register(
      dynamicInjector.register(PLAN_MODE_INJECTION_VARIANT, async ({ injectedAt }) => {
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
        const variant = planModeReminderVariant(injectedAt, this.context.getHistory());
        if (variant === 'full') return this.fullReminder();
        if (variant === 'sparse') return this.sparseReminder();
        return undefined;
      }),
    );
  }

  get isActive(): boolean {
    return this._active;
  }

  get planFilePath(): PlanFilePath {
    return this._planFilePath;
  }

  private createPlanId(): string {
    return generateHeroSlug(randomUUID(), new Set());
  }

  async enter(
    id = this.createPlanId(),
    createFile = false,
    emitStatus = true,
  ): Promise<void> {
    if (this._active) {
      throw new Error('Already in plan mode');
    }

    this._active = true;
    this.planId = id;
    this._planFilePath = null;

    let enterRecorded = false;
    try {
      const planFilePath = this.planFilePathFor(id);
      this._planFilePath = planFilePath;
      await this.ensurePlanDirectory(planFilePath);
      this.wireRecord.append({ type: 'plan_mode.enter', id });
      enterRecorded = true;
      if (createFile) {
        await this.writeEmptyPlanFile(planFilePath);
      }
    } catch (error) {
      if (enterRecorded) {
        this.cancel(id);
      } else {
        this.reset();
      }
      throw error;
    }

    if (emitStatus) this.emitChanged();
  }

  private restoreEnter({ id }: { readonly id: string }): void {
    this.replayBuilder.push({ type: 'plan_updated', enabled: true });
    this._active = true;
    this.planId = id;
    this._planFilePath = this.planFilePathFor(id);
  }

  cancel(id?: string): void {
    this.wireRecord.append({ type: 'plan_mode.cancel', id });
    this.replayBuilder.push({ type: 'plan_updated', enabled: false });
    this.applyInactive();
    this.emitChanged();
  }

  async clear(): Promise<void> {
    if (this._planFilePath === null) return;
    await this.writeEmptyPlanFile(this._planFilePath);
  }

  exit(id?: string): void {
    this.wireRecord.append({ type: 'plan_mode.exit', id });
    this.replayBuilder.push({ type: 'plan_updated', enabled: false });
    this.applyInactive();
    this.emitChanged();
  }

  async data(): Promise<PlanData> {
    if (this.planId === null || this._planFilePath === null) return null;
    const kaos = this.kaosService.kaos;
    if (kaos === undefined) return null;
    let content = '';
    try {
      content = await kaos.readText(this._planFilePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return {
      id: this.planId,
      content,
      path: this._planFilePath,
    };
  }

  private planFilePathFor(id: string): string {
    return join(this.currentCwd(), 'plan', `${id}.md`);
  }

  private async enterPlanModeToolResult(): Promise<ExecutableToolResult> {
    if (this._active) {
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

    return { output: enteredPlanModeMessage(this._planFilePath) };
  }

  private async resolvePlanReviewDisplay(
    args: ExitPlanModeInput,
  ): Promise<ToolInputDisplay | undefined> {
    if (!this._active) return undefined;
    let data: PlanData;
    try {
      data = await this.data();
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
    if (!this._active) {
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
      data = await this.data();
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
          this._planFilePath === null
            ? 'No plan file found. Write the plan to the current plan file first, then call ExitPlanMode.'
            : `No plan file found. Write your plan to ${this._planFilePath} first, then call ExitPlanMode.`,
      },
    };
  }

  private applyInactive(): void {
    this.reset();
  }

  private reset(): void {
    this._active = false;
    this.planId = null;
    this._planFilePath = null;
  }

  private emitChanged(): void {
    this.events.emit({ type: 'agent.status.updated', planMode: this._active });
  }

  private trackTelemetry(
    event: 'plan_submitted' | 'plan_resolved',
    properties: Record<string, string | number | boolean | undefined>,
  ): void {
    this.telemetry.track(event, properties);
  }

  private async hasCurrentPlanContent(): Promise<boolean> {
    try {
      const data = await this.data();
      return data !== null && data.content.trim().length > 0;
    } catch {
      return false;
    }
  }

  private fullReminder(): string {
    return fullReminder(this._planFilePath);
  }

  private sparseReminder(): string {
    return sparseReminder(this._planFilePath);
  }

  private reentryReminder(): string {
    return reentryReminder(this._planFilePath);
  }

  private async writeEmptyPlanFile(path: string): Promise<void> {
    await this.ensurePlanDirectory(path);
    await this.kaosService.kaos?.writeText(path, '');
  }

  private async ensurePlanDirectory(path: string): Promise<void> {
    await this.kaosService.kaos?.mkdir(dirname(path), {
      parents: true,
      existOk: true,
    });
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

export { PlanModeService as PlanMode };

registerSingleton(
  IPlanModeService,
  new SyncDescriptor(PlanModeService, [], true),
);
