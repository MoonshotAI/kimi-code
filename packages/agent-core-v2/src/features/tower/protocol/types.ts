export type TowerAgentKind = 'worker' | 'reviewer';

export interface TowerRosterEntry {
  /** Display/route name, e.g. `agent-build`, `reviewer-a`. Unique per workspace. */
  readonly name: string;
  /** Engine agent id (e.g. `agent-3`); the tower is always `main`. */
  readonly agentId: string;
  /**
   * Session that spawned this agent. Engine agent ids are only unique within
   * one session — after a CLI restart a new session reissues `agent-0`, … — so
   * an entry is meaningful (resumable, dereferenceable) only in its own
   * session. TowerInit retiring a foreign session's entries is what keeps
   * id→name resolution unambiguous.
   */
  readonly sessionId?: string;
  readonly kind: TowerAgentKind;
  /** Workers: the mission they own. */
  readonly missionId?: string;
  /** Reviewers: the branch they are assigned to review. */
  readonly reviewTarget?: string;
  /** Workers: worktree slot, e.g. `wt-1`. */
  readonly worktree?: string;
  /** Workers: their branch, e.g. `feat/vulkan-build`. */
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
  | 'merged';

/**
 * `build` missions change code: their scope reserves write access (plan-time
 * disjoint check, merge-time containment) and they merge through the full
 * review gate. `survey` missions are read-only investigations: their scope is
 * informational only (reserves nothing), and their merge is a zero-diff
 * formality that closes the mission without a git merge.
 */
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
  /** picomatch globs; mutable only through `updateMission` (tower, logged). */
  scope: string[];
  readonly branch: string;
  readonly worktree: string;
  readonly deps: readonly string[];
  status: TowerMissionStatus;
  owner?: string;
  tasks: TowerMissionTask[];
  /** Decision log, oldest first. */
  notes: string[];
  blockers: string[];
}

export interface TowerState {
  readonly version: 1;
  readonly base: string;
  /** `pr` is reserved for a future gh-backed mode; v1 always runs `branch`. */
  readonly mode: 'branch' | 'pr';
  readonly createdAt: string;
  /**
   * Session that most recently ran TowerInit here. A different session
   * re-initializing adopts the workspace: roster entries it did not spawn are
   * retired (their engine agent ids are meaningless outside their own
   * session), missions and worktrees are preserved.
   */
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
  /** Branch tip the review was written against; merge gate compares it. */
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
