import type { PlanFilePath } from '../plan';
import { DynamicInjector } from './injector';

const PLAN_MODE_DEDUP_MIN_TURNS = 2;
const PLAN_MODE_FULL_REFRESH_TURNS = 5;

/**
 * Plan-mode reminder variants.
 *
 * `reentry` is used once when a restored planning session already has plan
 * content. `full` is used for the first reminder and periodic refreshes.
 * `sparse` keeps the read-only invariant visible between full reminders.
 */
export type PlanModeVariant = 'full' | 'sparse' | 'reentry';

export class PlanModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'plan_mode';
  private wasActive = false;

  override onContextClear(): void {
    super.onContextClear();
    this.wasActive = this.agent.planMode.isActive;
  }

  override async getInjection(): Promise<string | undefined> {
    const { isActive, planFilePath } = this.agent.planMode;
    if (!isActive) {
      if (!this.wasActive) {
        return undefined;
      }
      this.wasActive = false;
      this.injectedAt = null;
      return exitReminder();
    }
    if (!this.wasActive) {
      this.injectedAt = null;
      this.wasActive = true;
      if (await this.hasCurrentPlanContent()) {
        return reentryReminder(planFilePath);
      }
    }
    const variant = this.getVariant();
    if (variant === null) return undefined;

    return variant === 'full'
      ? fullReminder(planFilePath)
      : variant === 'sparse'
        ? sparseReminder(planFilePath)
        : reentryReminder(planFilePath);
  }

  protected getVariant(): PlanModeVariant | null {
    if (this.injectedAt === null) return 'full';
    const history = this.agent.context.history;
    let assistantTurnsSince = 0;
    for (let i = this.injectedAt + 1; i < history.length; i++) {
      const msg = history[i];
      if (msg === undefined) continue;
      if (msg.role === 'assistant') {
        assistantTurnsSince += 1;
        continue;
      }
      if (msg.role === 'user') {
        return 'full';
      }
    }
    if (assistantTurnsSince >= PLAN_MODE_FULL_REFRESH_TURNS) return 'full';
    if (assistantTurnsSince >= PLAN_MODE_DEDUP_MIN_TURNS) return 'sparse';
    return null;
  }

  private async hasCurrentPlanContent(): Promise<boolean> {
    try {
      const data = await this.agent.planMode.data();
      return data !== null && data.content.trim().length > 0;
    } catch {
      return false;
    }
  }
}
function withPlanFileFooter(body: string, planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) return body;
  return `${body}\n\nPlan file: ${planFilePath}`;
}

function fullReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return inlineFullReminder();
  }

  const body = `Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file) or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received. TaskStop, CronCreate, and CronDelete are also blocked in plan mode — call ExitPlanMode first if you need them.

Workflow:
  1. Understand — explore the codebase with Glob, Grep, Read.
  2. Design — converge on the best approach; consider trade-offs but aim for a single recommendation.
  3. Review — re-read key files to verify understanding.
  4. Write Plan — modify the plan file with Write or Edit. Use Write if the plan file does not exist yet.
  5. Exit — call ExitPlanMode for user approval.

## Handling multiple approaches
Keep it focused: at most 2-3 meaningfully different approaches. Do NOT pad with minor variations — if one approach is clearly superior, just propose that one.
When the best approach depends on user preferences, constraints, or context you don't have, use AskUserQuestion to clarify first. This helps you write a better, more targeted plan rather than dumping multiple options for the user to sort through.
When you do include multiple approaches in the plan, you MUST pass them as the \`options\` parameter when calling ExitPlanMode, so the user can select which approach to execute at approval time.
NEVER write multiple approaches in the plan and call ExitPlanMode without the \`options\` parameter — the user will only see the default approval controls with no way to choose a specific approach.

AskUserQuestion is for clarifying missing requirements or user preferences that affect the plan.
Never ask about plan approval via text or AskUserQuestion.
Your turn must end with either AskUserQuestion (to clarify requirements or preferences) or ExitPlanMode (to request plan approval). Do NOT end your turn any other way.
Do NOT use AskUserQuestion to ask about plan approval or reference "the plan" — the user cannot see the plan until you call ExitPlanMode.`;
  return withPlanFileFooter(body, planFilePath);
}

function sparseReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return inlineSparseReminder();
  }

  const body = `Plan mode still active (see full instructions earlier). Prefer read-only tools except the current plan file. Use Write or Edit to modify the plan file. If it does not exist yet, create it with Write first. Use Bash only when needed; Bash follows the normal permission mode and rules. Use AskUserQuestion to clarify user preferences when it helps you write a better plan. If the plan has multiple approaches, pass options to ExitPlanMode so the user can choose. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for approval). Never ask about plan approval via text or AskUserQuestion.`;
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
  1. Understand — explore the codebase with Glob, Grep, Read.
  2. Design — converge on the best approach; consider trade-offs but aim for a single recommendation.
  3. Review — re-read key files to verify understanding.
  4. Wait for the host to provide a plan file path, write the plan there, then call ExitPlanMode.

## Handling multiple approaches
Keep it focused: at most 2-3 meaningfully different approaches. Do NOT pad with minor variations — if one approach is clearly superior, just propose that one.
When the best approach depends on user preferences, constraints, or context you don't have, use AskUserQuestion to clarify first.
When you do include multiple approaches in the plan, you MUST pass them as the \`options\` parameter when calling ExitPlanMode, so the user can select which approach to execute at approval time.

AskUserQuestion is for clarifying missing requirements or user preferences that affect the plan.
Never ask about plan approval via text or AskUserQuestion.
Your turn must end with either AskUserQuestion (to clarify requirements or preferences) or ExitPlanMode (to request plan approval). Do NOT end your turn any other way.`;
}

function inlineSparseReminder(): string {
  return `Plan mode still active (see full instructions earlier). Read-only; no plan file path is available in this host. Wait for the host to provide a plan file path before calling ExitPlanMode. Use AskUserQuestion to clarify user preferences when it helps you write a better plan. If the plan has multiple approaches, pass options to ExitPlanMode so the user can choose. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for approval).`;
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

function exitReminder(): string {
  return `Plan mode is no longer active. The read-only and plan-file-only restrictions from plan mode no longer apply. Continue with the approved plan using the normal tool and permission rules.`;
}
