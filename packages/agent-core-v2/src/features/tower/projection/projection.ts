import { TowerStore } from '#/features/tower/protocol/index';
import type {
  TowerMission,
  TowerMissionKind,
  TowerMissionStatus,
  TowerState,
} from '#/features/tower/protocol/index';

import { parseTowerActivityLine, type TowerActivityEvent } from './activityParse';
import { readTowerLogTail } from './logTail';

export type TowerProjectionStatus = 'uninitialized' | 'lost' | 'off' | 'active';

export interface TowerProjectionMissionCounts {
  readonly planned: number;
  readonly active: number;
  readonly completed: number;
  readonly blocked: number;
  readonly paused: number;
  readonly merged: number;
  readonly abandoned: number;
}

export interface TowerProjectionOpenMission {
  readonly id: string;
  readonly title: string;
  readonly kind: TowerMissionKind;
  readonly status: TowerMissionStatus;
  owner?: string;
  readonly branch: string;
  readonly scope: readonly string[];
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly blockers: number;
  latestNotePreview?: string;
  readonly liveWorkers: number;
}

export interface TowerProjectionClosedMission {
  readonly id: string;
  readonly title: string;
  readonly status: 'merged' | 'abandoned';
  closedAt?: string;
}

export interface TowerProjection {
  readonly status: TowerProjectionStatus;
  readonly hasContent: boolean;
  base?: string;
  mode?: 'branch' | 'pr';
  recoveredAt?: string;
  readonly missionCounts: TowerProjectionMissionCounts;
  readonly workersLive: number;
  readonly reviewersLive: number;
  readonly rosterTotal: number;
  readonly openMissions: readonly TowerProjectionOpenMission[];
  readonly recentClosed: readonly TowerProjectionClosedMission[];
  readonly events: readonly TowerActivityEvent[];
  readonly logOffset: number;
}

export const TOWER_PROJECTION_RECENT_CLOSED_LIMIT = 20;
export const TOWER_PROJECTION_LOG_SCAN_BYTES = 1_048_576;
export const TOWER_NOTE_PREVIEW_MAX = 120;
export const TOWER_ACTIVITY_FEED_LIMIT = 50;

const OPEN_MISSION_STATUSES: ReadonlySet<TowerMissionStatus> = new Set([
  'planned',
  'active',
  'completed',
  'blocked',
  'paused',
]);

const OPEN_MISSION_STATUS_ORDER: Readonly<Record<TowerMissionStatus, number>> = {
  active: 0,
  blocked: 1,
  paused: 2,
  completed: 3,
  planned: 4,
  merged: 5,
  abandoned: 6,
};

interface ProjectionSource {
  readonly status: TowerProjectionStatus;
  readonly state?: TowerState;
}

function emptyMissionCounts(): TowerProjectionMissionCounts {
  return {
    planned: 0,
    active: 0,
    completed: 0,
    blocked: 0,
    paused: 0,
    merged: 0,
    abandoned: 0,
  };
}

function tallyMissions(missions: readonly TowerMission[]): TowerProjectionMissionCounts {
  const counts: Record<TowerMissionStatus, number> = {
    planned: 0,
    active: 0,
    completed: 0,
    blocked: 0,
    paused: 0,
    merged: 0,
    abandoned: 0,
  };
  for (const mission of missions) counts[mission.status] += 1;
  return counts;
}

function missionNumber(id: string): number {
  const parsed = Number.parseInt(id.replace(/^M/, ''), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function notePreview(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const codePoints = Array.from(note);
  if (codePoints.length <= TOWER_NOTE_PREVIEW_MAX) return note;
  return codePoints.slice(0, TOWER_NOTE_PREVIEW_MAX).join('');
}

function compareClosedMissions(
  a: TowerProjectionClosedMission,
  b: TowerProjectionClosedMission,
): number {
  if (a.closedAt !== undefined && b.closedAt !== undefined) {
    const byTime = b.closedAt.localeCompare(a.closedAt);
    if (byTime !== 0) return byTime;
    return missionNumber(b.id) - missionNumber(a.id);
  }
  if (a.closedAt !== undefined) return -1;
  if (b.closedAt !== undefined) return 1;
  return missionNumber(b.id) - missionNumber(a.id);
}

function missionClosedAt(
  mission: TowerMission,
  events: readonly TowerActivityEvent[],
): string | undefined {
  let closedAt: string | undefined;
  for (const event of events) {
    if (mission.status === 'merged') {
      if (event.kind === 'merge' && event.fields['branch'] === mission.branch) {
        closedAt = event.at;
      }
      continue;
    }
    if (
      event.kind === 'mission.update' &&
      event.fields['id'] === mission.id &&
      event.fields['status'] === 'abandoned'
    ) {
      closedAt = event.at;
    }
  }
  return closedAt;
}

function emptyProjection(status: TowerProjectionStatus): TowerProjection {
  return {
    status,
    hasContent: false,
    missionCounts: emptyMissionCounts(),
    workersLive: 0,
    reviewersLive: 0,
    rosterTotal: 0,
    openMissions: [],
    recentClosed: [],
    events: [],
    logOffset: 0,
  };
}

async function loadProjectionSource(store: TowerStore): Promise<ProjectionSource> {
  if (await store.isInitialized()) {
    const state = await store.load();
    return { status: state.sessionId === undefined ? 'off' : 'active', state };
  }
  return { status: (await store.isStateLost()) ? 'lost' : 'uninitialized' };
}

export async function readTowerProjection(repoRoot: string): Promise<TowerProjection> {
  const source = await loadProjectionSource(new TowerStore(repoRoot));
  const state = source.state;
  if (state === undefined) return emptyProjection(source.status);

  const tail = await readTowerLogTail(repoRoot, TOWER_PROJECTION_LOG_SCAN_BYTES);
  const events = tail.lines
    .map(parseTowerActivityLine)
    .filter((event): event is TowerActivityEvent => event !== undefined);
  const openMissionIds = new Set(
    state.missions
      .filter((mission) => OPEN_MISSION_STATUSES.has(mission.status))
      .map((mission) => mission.id),
  );

  let workersLive = 0;
  let reviewersLive = 0;
  const liveWorkersByMission = new Map<string, number>();
  for (const agent of state.roster.agents) {
    if (agent.kind === 'worker') {
      if (agent.diedAt !== undefined || agent.missionId === undefined) continue;
      liveWorkersByMission.set(
        agent.missionId,
        (liveWorkersByMission.get(agent.missionId) ?? 0) + 1,
      );
      if (openMissionIds.has(agent.missionId)) workersLive += 1;
      continue;
    }
    if (agent.diedAt !== undefined) continue;
    if (agent.reviewMissionId === undefined || openMissionIds.has(agent.reviewMissionId)) {
      reviewersLive += 1;
    }
  }

  const openMissions = state.missions
    .filter((mission) => OPEN_MISSION_STATUSES.has(mission.status))
    .toSorted(
      (a, b) =>
        OPEN_MISSION_STATUS_ORDER[a.status] - OPEN_MISSION_STATUS_ORDER[b.status] ||
        missionNumber(a.id) - missionNumber(b.id),
    )
    .map((mission): TowerProjectionOpenMission => ({
      id: mission.id,
      title: mission.title,
      kind: mission.kind,
      status: mission.status,
      owner: mission.owner,
      branch: mission.branch,
      scope: mission.scope,
      tasksDone: mission.tasks.filter((task) => task.done).length,
      tasksTotal: mission.tasks.length,
      blockers: mission.blockers.length,
      latestNotePreview: notePreview(mission.notes.at(-1)),
      liveWorkers: liveWorkersByMission.get(mission.id) ?? 0,
    }));

  const recentClosed = state.missions
    .filter((mission) => mission.status === 'merged' || mission.status === 'abandoned')
    .map((mission): TowerProjectionClosedMission => ({
      id: mission.id,
      title: mission.title,
      status: mission.status === 'merged' ? 'merged' : 'abandoned',
      closedAt: missionClosedAt(mission, events),
    }))
    .toSorted(compareClosedMissions)
    .slice(0, TOWER_PROJECTION_RECENT_CLOSED_LIMIT);

  return {
    status: source.status,
    hasContent: state.missions.length > 0 || state.roster.agents.length > 0,
    base: state.base,
    mode: state.mode,
    recoveredAt: state.recoveredAt,
    missionCounts: tallyMissions(state.missions),
    workersLive,
    reviewersLive,
    rosterTotal: state.roster.agents.length,
    openMissions,
    recentClosed,
    events: events.slice(-TOWER_ACTIVITY_FEED_LIMIT),
    logOffset: tail.offset,
  };
}
