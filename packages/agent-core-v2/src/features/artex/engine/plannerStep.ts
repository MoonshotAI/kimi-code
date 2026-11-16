import type { ArtexExplorationRoot, IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import type { ArtexIntentState, ArtexTaskConstraint } from '#/features/artex/protocol/index';
import { artexBudgetStateLine, type ArtexBudgetState } from '#/features/artex/logic/budget';
import { ARTEX_PLANNER_PROMPT, substituteArtexGoal } from '#/features/artex/prompts/index';

export interface ArtexFrontierSummary {
  readonly goalMet: boolean;
  readonly openIntents: number;
  readonly runningIntents: number;
  readonly pausedIntents: number;
  readonly blockedIntents: number;
}

export function emptyFrontierSummary(): ArtexFrontierSummary {
  return {
    goalMet: true,
    openIntents: 0,
    runningIntents: 0,
    pausedIntents: 0,
    blockedIntents: 0,
  };
}

/**
 * The planner hard-floor rule: while a goal is still unmet and the executable
 * frontier is empty (no open and no running intents), the planner is obliged to
 * emit at least one new intent so the exploration can never stall silently.
 */
export function requiresIntentFloor(summary: ArtexFrontierSummary): boolean {
  if (summary.goalMet) return false;
  return summary.openIntents === 0 && summary.runningIntents === 0;
}

export function shouldRunPlanner(summary: ArtexFrontierSummary): boolean {
  if (summary.goalMet) return false;
  if (requiresIntentFloor(summary)) return true;
  return summary.openIntents === 0;
}

export async function buildFrontierSummary(
  store: IArtexGraphStore,
): Promise<ArtexFrontierSummary> {
  const [nodes, exploration] = await Promise.all([store.nodes(), store.exploration()]);
  const counts: Record<ArtexIntentState, number> = {
    open: 0,
    running: 0,
    paused: 0,
    done: 0,
    blocked: 0,
    exhausted: 0,
    stopped: 0,
    deleted: 0,
  };
  let goalCount = 0;
  let openGoalCount = 0;
  for (const node of nodes) {
    if (node.kind === 'intent') counts[node.state] += 1;
    if (node.kind === 'goal') {
      goalCount += 1;
      if (node.state === 'open') openGoalCount += 1;
    }
  }
  const goalMet =
    exploration.status === 'achieved' ||
    (goalCount > 0 && openGoalCount === 0);
  return {
    goalMet,
    openIntents: counts.open,
    runningIntents: counts.running,
    pausedIntents: counts.paused,
    blockedIntents: counts.blocked,
  };
}

export function buildPlannerSystemPrompt(goal: string): string {
  return substituteArtexGoal(ARTEX_PLANNER_PROMPT, goal);
}

export function buildPlannerBrief(input: {
  readonly root: ArtexExplorationRoot;
  readonly summary: ArtexFrontierSummary;
  readonly stats: Record<string, number>;
  readonly constraints?: readonly ArtexTaskConstraint[];
  readonly budgetState?: ArtexBudgetState;
}): string {
  const { root, summary, stats, constraints, budgetState } = input;
  const lines: string[] = [];
  lines.push('<planner_round>');
  lines.push(`<goal>${root.goal}</goal>`);
  if (root.description.trim().length > 0) {
    lines.push(`<scope>${root.description}</scope>`);
  }
  if (constraints !== undefined && constraints.length > 0) {
    lines.push('<operation_constraints>');
    for (const c of constraints) {
      lines.push(`- [${c.kind}] ${c.text}`);
    }
    lines.push('</operation_constraints>');
  }
  if (budgetState !== undefined) {
    lines.push(`<budget>${artexBudgetStateLine(budgetState)}</budget>`);
  }
  lines.push(
    `<frontier open="${String(summary.openIntents)}" running="${String(
      summary.runningIntents,
    )}" paused="${String(summary.pausedIntents)}" blocked="${String(
      summary.blockedIntents,
    )}" />`,
  );
  const statLine = Object.entries(stats)
    .map(([kind, count]) => `${kind}=${String(count)}`)
    .join(' ');
  if (statLine.length > 0) {
    lines.push(`<graph>${statLine}</graph>`);
  }
  if (requiresIntentFloor(summary)) {
    lines.push(
      '<hard_floor>The goal is unmet and the executable frontier is empty (no open, no running intents). You MUST call add_intent at least once this round to seed new work — returning without emitting an intent would stall the exploration.</hard_floor>',
    );
  }
  lines.push('</planner_round>');
  return lines.join('\n');
}
