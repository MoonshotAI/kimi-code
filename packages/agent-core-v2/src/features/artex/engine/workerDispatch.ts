import { ARTEX_WORKER_PROMPT, substituteArtexGoal } from '#/features/artex/prompts/index';
import type { ArtexExplorationRoot, IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import type {
  ArtexIntentNode,
  ArtexIntentSettleState,
  ArtexTaskConstraint,
} from '#/features/artex/protocol/index';
import {
  isArtexBudgetCapReason,
  isArtexTerminalReason,
  type ArtexTerminalReason,
} from '#/features/artex/logic/terminalReason';

export interface ArtexClaimedIntent {
  readonly intentId: number;
  readonly token: string;
  readonly intent: ArtexIntentNode;
}

export type ArtexSwarmStatus = 'completed' | 'failed' | 'aborted';

export interface ArtexWorkerOutcome {
  readonly status: ArtexSwarmStatus;
  readonly stopReason?: string;
}

const MAX_TURNS_PATTERN = /max[_ ]?turns|turn cap/;
const TIMEOUT_PATTERN = /time[_ ]?out|timed out|duration|deadline/;

export function normalizeArtexTerminalReason(outcome: ArtexWorkerOutcome): ArtexTerminalReason {
  const raw = (outcome.stopReason ?? '').trim();
  if (isArtexTerminalReason(raw)) return raw;
  const low = raw.toLowerCase();
  switch (outcome.status) {
    case 'completed':
      if (MAX_TURNS_PATTERN.test(low)) return 'max_turns';
      if (TIMEOUT_PATTERN.test(low)) return 'timeout';
      return 'completed';
    case 'aborted':
      return 'aborted_tools';
    case 'failed':
      return 'model_error';
    default: {
      const exhaustive: never = outcome.status;
      return exhaustive;
    }
  }
}

/**
 * Terminal routing mirrors ARTEX: a model/transport failure blocks the intent, a
 * user cancellation stops it, hitting the turn/time cap exhausts it (so the
 * planner may redirect rather than treat it as failed), and a clean finish marks
 * it done.
 */
export function artexSettleForOutcome(outcome: ArtexWorkerOutcome): ArtexIntentSettleState {
  switch (outcome.status) {
    case 'aborted':
      return 'stopped';
    case 'failed':
      return 'blocked';
    case 'completed':
      return isArtexBudgetCapReason(normalizeArtexTerminalReason(outcome)) ? 'exhausted' : 'done';
    default: {
      const exhaustive: never = outcome.status;
      return exhaustive;
    }
  }
}

export async function claimOpenFrontier(
  store: IArtexGraphStore,
  owner: string,
  limit: number,
): Promise<ArtexClaimedIntent[]> {
  if (limit <= 0) return [];
  const frontier = await store.frontier(Math.max(limit * 2, limit));
  const claimed: ArtexClaimedIntent[] = [];
  for (const intent of frontier) {
    if (claimed.length >= limit) break;
    const result = await store.claimIntentToken(intent.id, owner);
    if (result.claimed && result.token !== undefined) {
      claimed.push({ intentId: intent.id, token: result.token, intent });
    }
  }
  return claimed;
}

function intentText(intent: ArtexIntentNode): string {
  const payload = intent.payload;
  for (const key of ['text', 'intent', 'summary', 'description', 'task']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return JSON.stringify(payload);
}

export function buildWorkerSystemPrompt(goal: string): string {
  return substituteArtexGoal(ARTEX_WORKER_PROMPT, goal);
}

export function buildWorkerBrief(input: {
  readonly intent: ArtexIntentNode;
  readonly root: ArtexExplorationRoot;
  readonly constraints?: readonly ArtexTaskConstraint[];
}): string {
  const { intent, root, constraints } = input;
  const lines: string[] = [];
  lines.push('<worker_task>');
  lines.push(`<exploration_goal>${root.goal}</exploration_goal>`);
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
  lines.push(`<intent id="${String(intent.id)}" priority="${String(intent.priority)}">`);
  lines.push(intentText(intent));
  lines.push('</intent>');
  lines.push(
    '<instructions>Execute this single intent. Use record_fact for observations, report_finding for confirmed vulnerabilities, record_coverage to log what you examined, and insert_assets for newly discovered attack surface. Do not plan beyond this intent — the planner owns decomposition.</instructions>',
  );
  lines.push('</worker_task>');
  return lines.join('\n');
}
