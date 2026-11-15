import type { ArtexExplorationRoot, IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import type { ArtexIntentState } from '#/features/artex/protocol/index';

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
  const [nodes, hasOpenGoal] = await Promise.all([store.nodes(), store.hasOpenGoal()]);
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
  for (const node of nodes) {
    if (node.kind === 'intent') counts[node.state] += 1;
  }
  return {
    goalMet: !hasOpenGoal,
    openIntents: counts.open,
    runningIntents: counts.running,
    pausedIntents: counts.paused,
    blockedIntents: counts.blocked,
  };
}

export function buildPlannerBrief(input: {
  readonly root: ArtexExplorationRoot;
  readonly summary: ArtexFrontierSummary;
  readonly stats: Record<string, number>;
}): string {
  const { root, summary, stats } = input;
  const lines: string[] = [];
  lines.push('<planner_round>');
  lines.push(`<goal>${root.goal}</goal>`);
  if (root.description.trim().length > 0) {
    lines.push(`<scope>${root.description}</scope>`);
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
