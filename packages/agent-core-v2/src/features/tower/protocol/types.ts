export type TowerAgentKind = 'worker' | 'reviewer';

export interface TowerRosterEntry {
  readonly name: string;
  readonly agentId: string;
  readonly sessionId?: string;
  readonly kind: TowerAgentKind;
  readonly missionId?: string;
  readonly reviewTarget?: string;
  readonly worktree?: string;
  readonly branch?: string;
  readonly spawnedAt: string;
}

export interface TowerRoster {
  readonly agents: TowerRosterEntry[];
}

export type TowerMissionStatus =
  | 'planned'
  | 'active'
  | 'completed'
  | 'blocked'
  | 'paused'
  | 'merged'
  | 'abandoned';

export type TowerMissionKind = 'build' | 'survey';

export interface TowerMissionTask {
  text: string;
  done: boolean;
}

export interface TowerMission {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  kind: TowerMissionKind;
  scope: string[];
  readonly branch: string;
  readonly worktree: string;
  readonly deps: readonly string[];
  status: TowerMissionStatus;
  owner?: string;
  tasks: TowerMissionTask[];
  notes: string[];
  blockers: string[];
}

export interface TowerState {
  readonly version: 1;
  readonly base: string;
  readonly mode: 'branch' | 'pr';
  readonly createdAt: string;
  sessionId?: string;
  roster: TowerRoster;
  missions: TowerMission[];
}

export type TowerFindingType = 'bug' | 'improve' | 'vuln' | 'idea';
export type TowerFindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export type TowerReviewStatus = 'clean' | `p1-${number}items` | `p2-${number}items`;
export type TowerReviewMerge = 'merge' | 'fix-then-merge' | 'hold';

export interface TowerReviewInfo {
  readonly reviewer: string;
  readonly target: string;
  readonly round: number;
  readonly status: string;
  readonly merge: string;
  readonly reviewedCommit: string;
  readonly date: string;
  readonly file: string;
}

export interface TowerInboxItem {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly sentAt: string;
  readonly scope?: string;
  readonly action?: string;
  readonly consentRef?: string;
  readonly body: string;
}
