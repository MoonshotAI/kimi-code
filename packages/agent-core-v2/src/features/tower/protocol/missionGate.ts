import picomatch from 'picomatch';

import type { TowerMission, TowerReviewInfo, TowerState } from './types';

export type TowerWorkerRuntimeStatus = 'idle' | 'busy' | 'unknown';

export interface TowerMissionWorkerRuntime {
  readonly agentId: string;
  readonly name: string;
  readonly status: TowerWorkerRuntimeStatus;
}

export interface TowerMissionBranchObservation {
  readonly tip: string;
  readonly baseIsAncestor: boolean;
  readonly diffBase: string;
  readonly changedFiles: readonly string[];
  readonly mergeTouchedFiles: readonly string[];
}

export interface TowerMissionGitObservations {
  readonly baseTip: string;
  readonly headTip: string;
  readonly checkedOutBranch?: string;
  readonly baseDirtyFiles: readonly string[];
  readonly branch?: TowerMissionBranchObservation;
}

export type TowerReviewBinding = 'exact-tip' | 'clean-rebase-waived' | 'stale-tip';

export type TowerMissionGateReason =
  | 'not-completed'
  | 'open-tasks'
  | 'blockers'
  | 'worker-busy'
  | 'worker-unknown'
  | 'deps-unmerged'
  | 'branch-missing'
  | 'read-only-survey'
  | 'stale-base'
  | 'no-review'
  | 'review-hold'
  | 'not-clean'
  | 'review-not-approved'
  | 'tip-moved'
  | 'review-mission-mismatch'
  | 'out-of-scope'
  | 'base-mismatch'
  | 'base-dirty';

export interface TowerMissionGateBlock {
  readonly reason: TowerMissionGateReason;
  readonly message: string;
}

export interface TowerMissionGateInput {
  readonly state: TowerState;
  readonly mission: TowerMission;
  readonly reviews: readonly TowerReviewInfo[];
  readonly workers: readonly TowerMissionWorkerRuntime[];
  readonly observations: TowerMissionGitObservations;
}

export interface TowerMissionGateResult {
  readonly ready: boolean;
  readonly noop: boolean;
  readonly blocks: readonly TowerMissionGateBlock[];
  readonly selectedReview?: TowerReviewInfo;
  readonly reviewBinding?: TowerReviewBinding;
  readonly observations: TowerMissionGitObservations;
}

export function selectMissionReview(
  state: TowerState,
  mission: TowerMission,
  reviews: readonly TowerReviewInfo[],
): TowerReviewInfo | undefined {
  const siblingMissions = state.missions.filter(
    (candidate) => candidate.branch === mission.branch && candidate.id !== mission.id,
  );
  const stamped = reviews.filter((review) => review.mission === mission.id);
  const candidates =
    stamped.length > 0
      ? reviews.filter(
          (review) =>
            review.mission === mission.id ||
            (review.mission === undefined && siblingMissions.length === 0),
        )
      : reviews.filter((review) => review.mission === undefined);
  return candidates.at(-1);
}

export function evaluateMissionGate(input: TowerMissionGateInput): TowerMissionGateResult {
  const { state, mission, reviews, workers, observations } = input;
  const selectedReview =
    mission.kind === 'build' ? selectMissionReview(state, mission, reviews) : undefined;
  const reviewBinding = reviewBindingFor(mission, selectedReview, observations.branch?.tip);
  const result = (blocks: readonly TowerMissionGateBlock[]): TowerMissionGateResult => ({
    ready: blocks.length === 0,
    noop: blocks.length === 0 && mission.kind === 'survey',
    blocks,
    selectedReview,
    reviewBinding,
    observations,
  });
  const block = (reason: TowerMissionGateReason, message: string): TowerMissionGateResult =>
    result([{ reason, message: `merge blocked: ${message}` }]);

  const commonBlocks: TowerMissionGateBlock[] = [];
  if (mission.status !== 'completed') {
    commonBlocks.push({
      reason: 'not-completed',
      message: `merge blocked: mission ${mission.id} is ${mission.status} — only a completed mission can merge`,
    });
  }
  const openTasks = mission.tasks.filter((task) => !task.done && task.dropped !== true);
  if (openTasks.length > 0) {
    commonBlocks.push({
      reason: 'open-tasks',
      message: `merge blocked: mission ${mission.id} has ${String(openTasks.length)} open task(s): ${openTasks.map((task) => `"${task.text}"`).join(', ')}`,
    });
  }
  if (mission.blockers.length > 0) {
    commonBlocks.push({
      reason: 'blockers',
      message: `merge blocked: mission ${mission.id} has ${String(mission.blockers.length)} blocker(s): ${mission.blockers.join(' | ')}`,
    });
  }
  const busyWorkers = workers.filter((worker) => worker.status === 'busy');
  if (busyWorkers.length > 0) {
    commonBlocks.push({
      reason: 'worker-busy',
      message: `merge blocked: worker(s) ${busyWorkers.map((worker) => worker.name).join(', ')} are mid-turn — wait for every mission worker to become idle before merging`,
    });
  }
  const unknownWorkers = workers.filter((worker) => worker.status === 'unknown');
  if (unknownWorkers.length > 0) {
    commonBlocks.push({
      reason: 'worker-unknown',
      message: `merge blocked: worker runtime for ${unknownWorkers.map((worker) => worker.name).join(', ')} cannot be observed authoritatively — unknown is not idle; retry from the main tower agent`,
    });
  }
  if (commonBlocks.length > 0) return result(commonBlocks);

  const branch = observations.branch;
  if (branch === undefined) {
    return block(
      'branch-missing',
      `mission ${mission.id} branch "${mission.branch}" does not exist — spawn a worker and complete the mission before merging`,
    );
  }

  const unmergedDeps = mission.deps.filter((dep) => {
    const dependency = state.missions.find((candidate) => candidate.id === dep);
    return dependency !== undefined && dependency.status !== 'merged' && dependency.status !== 'abandoned';
  });
  if (unmergedDeps.length > 0) {
    return block(
      'deps-unmerged',
      `dependencies not merged yet (${unmergedDeps.join(', ')}) — merge in Dependency Flow order`,
    );
  }

  if (mission.kind === 'survey') {
    if (branch.changedFiles.length > 0) {
      return block(
        'read-only-survey',
        `survey mission ${mission.id} is read-only but ${mission.branch} has ${String(branch.changedFiles.length)} changed file(s): ${branch.changedFiles.slice(0, 5).join(', ')} — investigate the worker; if the changes are worth keeping, move them onto a build mission's branch`,
      );
    }
    return result([]);
  }

  if (!branch.baseIsAncestor) {
    return block(
      'stale-base',
      `${mission.branch} is behind base "${state.base}" — the base moved after this branch spawned, so merging now could land code that was never built or reviewed against the current base; run TowerRebase(mission="${mission.id}") first (it rebases in the mission worktree, refuses while the worker is mid-turn or the worktree is dirty, and a conflict-free rebase waives the re-review), then retry the merge`,
    );
  }
  if (selectedReview === undefined) {
    return block('no-review', `${mission.branch} has no review — assign a reviewer first`);
  }
  if (selectedReview.merge === 'hold') {
    return block(
      'review-hold',
      `latest applicable review (round ${String(selectedReview.round)} by ${selectedReview.reviewer}) says hold — do not merge until a later clean review with merge approval supersedes it`,
    );
  }
  if (selectedReview.status !== 'clean') {
    return block(
      'not-clean',
      `latest review (round ${String(selectedReview.round)} by ${selectedReview.reviewer}) is "${selectedReview.status}" — a clean round is required`,
    );
  }
  const mergeVerdict = selectedReview.merge || '';
  if (mergeVerdict !== 'merge' && mergeVerdict !== '') {
    return block(
      'review-not-approved',
      `latest clean review (round ${String(selectedReview.round)} by ${selectedReview.reviewer}) has merge verdict "${mergeVerdict}" — fix-then-merge is not approval; only a clean review with merge verdict "merge" can pass`,
    );
  }
  if (reviewBinding === 'stale-tip') {
    return block(
      'tip-moved',
      `${mission.branch} moved since the clean review (reviewed ${selectedReview.reviewedCommit.slice(0, 7)}, tip ${branch.tip.slice(0, 7)}) — re-review required`,
    );
  }
  const siblingMissions = state.missions.filter(
    (candidate) => candidate.branch === mission.branch && candidate.id !== mission.id,
  );
  if (selectedReview.mission === undefined && siblingMissions.length > 0) {
    return block(
      'review-mission-mismatch',
      `"${mission.branch}" is shared with other mission record(s) ${siblingMissions.map((sibling) => `${sibling.id} (${sibling.status})`).join(', ')}, and the latest clean review (round ${String(selectedReview.round)} by ${selectedReview.reviewer}) predates mission-stamped reviews — re-review ${mission.id} so the gate can tell which mission was audited`,
    );
  }
  const outOfScope = branch.changedFiles.filter(
    (file) => !mission.scope.some((glob) => picomatch.isMatch(file, glob)),
  );
  if (outOfScope.length > 0) {
    return block(
      'out-of-scope',
      `${mission.branch} changed files outside mission ${mission.id} scope (${mission.scope.join(', ')}): ${outOfScope.join(', ')} — the tower must widen the mission scope (TowerMission scope patch) or revert those changes`,
    );
  }
  if (observations.checkedOutBranch !== state.base) {
    return block(
      'base-mismatch',
      observations.checkedOutBranch === undefined
        ? `the main checkout is in a detached HEAD state — check out the recorded base branch "${state.base}" before merging; nothing was merged`
        : `the main checkout is on "${observations.checkedOutBranch}", not the recorded base "${state.base}" — switch it back (\`git checkout ${state.base}\`) and retry, or when development has moved to "${observations.checkedOutBranch}", re-anchor the workspace to it first (/tower ${observations.checkedOutBranch}, or TowerInit with base="${observations.checkedOutBranch}"); nothing was merged`,
    );
  }
  const dirty = new Set(observations.baseDirtyFiles);
  const blockedDirty = branch.mergeTouchedFiles.filter((file) => dirty.has(file));
  if (blockedDirty.length > 0) {
    return block(
      'base-dirty',
      `the main checkout has uncommitted changes in file(s) this merge would overwrite: ${blockedDirty.slice(0, 5).join(', ')} — commit or stash them first, then retry; nothing was merged`,
    );
  }
  return result([]);
}

function reviewBindingFor(
  mission: TowerMission,
  review: TowerReviewInfo | undefined,
  tip: string | undefined,
): TowerReviewBinding | undefined {
  if (review === undefined || tip === undefined) return undefined;
  if (review.reviewedCommit === tip) return 'exact-tip';
  const waiver = mission.lastRebase;
  return waiver !== undefined && waiver.fromCommit === review.reviewedCommit && waiver.toCommit === tip
    ? 'clean-rebase-waived'
    : 'stale-tip';
}
