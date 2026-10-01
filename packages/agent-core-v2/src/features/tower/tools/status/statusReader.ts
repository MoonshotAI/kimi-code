import type { IAgentTaskService } from '#/agent/task/task';
import {
  resolveTowerRepoRoot,
  TowerStore,
  type TowerMissionGateBlock,
  type TowerReviewBinding,
  type TowerState,
} from '#/features/tower/protocol/index';

import { callerName } from '../support';

const INBOX_COUNT_LIMIT = 1000;
const RECENT_LOG_LINES = 10;

export interface TowerStatusConcurrency {
  readonly budget: number;
  readonly inflight: number;
  readonly blockedUntil: number | null;
}

export interface TowerStatusState {
  readonly base: TowerState['base'];
  readonly mode: TowerState['mode'];
  readonly missions: TowerState['missions'];
  readonly roster: TowerState['roster'];
}

export interface TowerStatusReview {
  readonly reviewer: string;
  readonly round: number;
  readonly status: string;
  readonly merge: string;
}

export interface TowerStatusGate {
  readonly missionId: string;
  readonly branch: string;
  readonly ready: boolean;
  readonly noop: boolean;
  readonly blocks: readonly TowerMissionGateBlock[];
  readonly selectedReview?: TowerStatusReview;
  readonly reviewBinding?: TowerReviewBinding;
}

export interface InitializedTowerStatus {
  readonly active: boolean;
  readonly initialized: true;
  readonly state: TowerStatusState;
  readonly caller: string;
  readonly gate: readonly TowerStatusGate[];
  readonly inbox: { readonly count: number };
  readonly concurrency: TowerStatusConcurrency;
  readonly recentActivity: readonly string[];
}

export type ActiveTowerStatus = InitializedTowerStatus & { readonly active: true };

export type TowerStatus =
  | { readonly active: boolean; readonly initialized: false }
  | InitializedTowerStatus;

export interface ReadTowerStatusInput {
  readonly active: boolean;
  readonly cwd: string;
  readonly agentId: string;
  readonly tasks: IAgentTaskService;
  readonly concurrency: () => TowerStatusConcurrency;
}

export async function readTowerStatus(input: ReadTowerStatusInput): Promise<TowerStatus> {
  const store = new TowerStore(resolveTowerRepoRoot(input.cwd));
  const initialized = await store.isInitialized();
  if (!initialized) return { active: input.active, initialized: false };

  const state = await store.load();
  const caller = callerName(input.agentId, store, state);
  const pending = state.missions.filter(
    (mission) => mission.status !== 'merged' && mission.status !== 'abandoned',
  );
  const activeAgentIds =
    pending.length > 0 && input.agentId === 'main'
      ? new Set(
          input.tasks
            .list(true)
            .flatMap((task) =>
              task.kind === 'agent' && task.agentId !== undefined ? [task.agentId] : [],
            ),
        )
      : undefined;
  const gate: TowerStatusGate[] = [];
  for (const mission of pending) {
    const result = await store.missionGate(state, mission, { activeAgentIds });
    gate.push({
      missionId: mission.id,
      branch: mission.branch,
      ready: result.ready,
      noop: result.noop,
      blocks: result.blocks,
      selectedReview:
        result.selectedReview === undefined
          ? undefined
          : {
              reviewer: result.selectedReview.reviewer,
              round: result.selectedReview.round,
              status: result.selectedReview.status,
              merge: result.selectedReview.merge,
            },
      reviewBinding: result.reviewBinding,
    });
  }
  const inbox = await store.readInbox(caller, INBOX_COUNT_LIMIT);
  const concurrency = input.concurrency();
  const recentActivity = await store.recentLog(RECENT_LOG_LINES);
  return {
    active: input.active,
    initialized: true,
    state: {
      base: state.base,
      mode: state.mode,
      missions: state.missions,
      roster: state.roster,
    },
    caller,
    gate,
    inbox: { count: inbox.length },
    concurrency,
    recentActivity,
  };
}

export async function readTowerStatusSummary(input: ReadTowerStatusInput): Promise<string> {
  const status = await readTowerStatus(input);
  if (!status.initialized) {
    return status.active ? 'Tower mode: ON\nTower is not initialized.' : 'Tower mode: OFF';
  }
  const lines = [
    status.active ? 'Tower status — ON' : 'Tower mode: OFF',
    `Base: ${status.state.base} (mode: ${status.state.mode}) · You are: ${status.caller}`,
    'Missions:',
    ...summaryMissions(status.state),
    'Roster:',
    ...summaryRoster(status.state),
    'Review gate:',
    ...summaryGate(status.gate),
    `Inbox: ${String(status.inbox.count)} message(s)`,
    `Concurrency: ${summaryConcurrency(status.concurrency)}`,
    'Recent activity:',
    ...(status.recentActivity.length > 0
      ? status.recentActivity.map((line) => `  ${line}`)
      : ['  (empty)']),
  ];
  return lines.join('\n');
}

function summaryMissions(state: TowerStatusState): string[] {
  if (state.missions.length === 0) return ['  (none)'];
  return state.missions.map(
    (mission) =>
      `  ${mission.id} ${mission.title} — ${mission.status} · owner ${mission.owner ?? '—'} · ${mission.branch}`,
  );
}

function summaryRoster(state: TowerStatusState): string[] {
  if (state.roster.agents.length === 0) return ['  (none)'];
  return state.roster.agents.map((agent) => {
    const assignment =
      agent.kind === 'worker'
        ? `mission ${agent.missionId ?? '?'}`
        : `reviewing ${agent.reviewTarget ?? '?'}`;
    const death = agent.diedAt === undefined ? '' : ` · died ${agent.deathStatus ?? 'unknown'}`;
    return `  ${agent.name} (${agent.kind}) — ${assignment} · ${agent.agentId}${death}`;
  });
}

function summaryGate(gate: readonly TowerStatusGate[]): string[] {
  if (gate.length === 0) return ['  (no open missions)'];
  return gate.map((missionGate) => {
    const review = missionGate.selectedReview;
    const reviewText =
      review === undefined
        ? ''
        : ` · review round ${String(review.round)} by ${review.reviewer} ${review.status}/${review.merge || 'legacy'} · binding ${missionGate.reviewBinding ?? 'unavailable'}`;
    if (missionGate.ready) {
      return `  ${missionGate.missionId} ${missionGate.branch} — READY${missionGate.noop ? ' (zero-diff no-op)' : ''}${reviewText}`;
    }
    const reasons = missionGate.blocks.map((block) => block.reason).join(', ');
    return `  ${missionGate.missionId} ${missionGate.branch} — BLOCKED: ${reasons}${reviewText}`;
  });
}

function summaryConcurrency(snapshot: TowerStatusConcurrency): string {
  const base = `budget: ${String(snapshot.budget)} agent(s) · inflight: ${String(snapshot.inflight)}`;
  if (snapshot.blockedUntil === null) return `${base} · spawns open`;
  const remainingMs = snapshot.blockedUntil - Date.now();
  return remainingMs > 0
    ? `${base} · spawns paused for ~${String(Math.ceil(remainingMs / 1000))}s`
    : `${base} · spawn pause expired`;
}
