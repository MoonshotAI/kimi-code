import type { TowerMission, TowerRosterEntry } from '#/features/tower/protocol/index';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { ITowerRateLimitService } from '#/features/tower/towerRateLimit';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { runTowerTool } from '../support';
import DESCRIPTION from './status.md?raw';
import {
  ITowerStatusTool,
  TowerStatusToolInputSchema,
  type TowerStatusToolInput,
} from './status';
import {
  readTowerStatus,
  type TowerStatusConcurrency,
  type TowerStatusGate,
  type TowerStatusState,
} from './statusReader';

const STATUS_EMOJI: Record<TowerMission['status'], string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
  abandoned: '🚫',
};

export class TowerStatusTool implements ITowerStatusTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerStatus' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerStatusToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ITowerRateLimitService private readonly rateLimit: ITowerRateLimitService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
  ) {}

  resolveExecution(args: TowerStatusToolInput): ToolExecution {
    const limit = args.limit ?? 20;
    return {
      description: 'Reading tower status',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const status = await readTowerStatus({
            active: true,
            cwd: this.sessionContext.cwd,
            agentId: this.scopeContext.agentId,
            tasks: this.tasks,
            concurrency: () => this.rateLimit.snapshot(),
          });
          if (!status.initialized) {
            if (status.stateLost) {
              return { output: renderStateLostReport() };
            }
            return {
              output: 'tower is not initialized in this repository — run TowerInit first',
              isError: true,
            };
          }
          if (!status.active) return { output: '# Tower status — OFF' };
          const { state, caller, gate, inbox, concurrency, recentActivity } = status;
          const sections: string[] = [
            `# Tower status — base: ${state.base} (mode: ${state.mode}), you are: ${caller}`,
            '',
            ...renderRecoveredAtWarning(state),
            '## Missions',
            '',
            ...renderMissions(state, limit),
            ...renderUnspawnedMissions(state, limit),
            ...renderDeathWarnings(state, limit),
            '',
            '## Roster',
            '',
            ...renderRoster(state, limit),
            '',
            '## Review gate (unmerged branches)',
            '',
            ...renderReviewGate(state, gate, limit),
          ];

          if (
            state.missions.length > 0 &&
            state.missions.every(
              (mission) => mission.status === 'merged' || mission.status === 'abandoned',
            )
          ) {
            sections.push(
              '',
              '## Done',
              '',
              'All missions are merged or abandoned. Free the worktree checkouts now: run TowerTeardown (branches and .tower/comms/ are kept; dirty worktrees are protected).',
            );
          }

          sections.push(
            '',
            '## Inbox',
            '',
            `${String(inbox.count)} message(s) visible to you — read with TowerInbox.`,
            '',
            '## Concurrency (adaptive)',
            '',
            renderConcurrency(concurrency),
            '',
            '## Recent activity',
            '',
            ...(recentActivity.length > 0 ? recentActivity : ['(activity log is empty)']),
          );
          return { output: sections.join('\n') };
        }),
    };
  }
}

function renderStateLostReport(): string {
  return [
    '# Tower status — STATE LOST',
    '',
    '.tower/comms/state.json is missing but the .tower/ directory still exists — this tower was initialized here before, and its comms state was deleted (e.g. by git clean). All recorded mission, roster, and review history is lost.',
    '',
    'Report this history loss to the user now — continuing silently would pretend the loss never happened.',
    '',
    'What still works:',
    '- TowerSend and TowerComplete recover a minimal state automatically (stamped recoveredAt, base taken from the current checkout branch) and keep delivering messages — worker reports are not lost.',
    '- TowerMerge and TowerRebase refuse with an explicit state-lost error instead of silently running against an empty history.',
    '- Mission branches and worktrees under .tower/worktrees survive on disk; re-plan from that evidence only after the user decides how to proceed.',
  ].join('\n');
}

function renderRecoveredAtWarning(state: TowerStatusState): string[] {
  if (state.recoveredAt === undefined) return [];
  return [
    '## ⚠️ State recovered after a loss',
    '',
    `This tower's state was reconstructed at ${state.recoveredAt} after .tower/comms/state.json was lost — every mission, roster entry, and review from before that point is gone, so the lists below are the recovered minimum, not reality. Report the history loss to the user before continuing routine orchestration.`,
    '',
  ];
}

function renderReviewGate(
  state: TowerStatusState,
  gate: readonly TowerStatusGate[],
  limit: number,
): string[] {
  const pending = state.missions.filter(
    (mission) => mission.status !== 'merged' && mission.status !== 'abandoned',
  );
  if (pending.length === 0) return ['(no open missions — or none planned yet)'];
  const visible = gate.slice(-limit).toReversed();
  const lines: string[] = [
    `Showing ${String(visible.length)} of ${String(pending.length)} open mission(s), newest first.`,
    '',
  ];
  for (const missionGate of visible) {
    const review = missionGate.selectedReview;
    const reviewText =
      review === undefined
        ? ''
        : `; review=round ${String(review.round)} by ${review.reviewer} ${review.status}/${review.merge || 'legacy'} binding=${missionGate.reviewBinding ?? 'unavailable'}`;
    if (missionGate.ready) {
      lines.push(
        `- ${missionGate.branch} (${missionGate.missionId}): READY reasons=none${missionGate.noop ? '; zero-diff survey no-op, review skipped' : ''}${reviewText}`,
      );
      continue;
    }
    const reasons = missionGate.blocks.map((block) => block.reason).join(',');
    const details = missionGate.blocks
      .map((block) => block.message.replace(/^merge blocked: /, ''))
      .join(' | ');
    lines.push(
      `- ${missionGate.branch} (${missionGate.missionId}): BLOCKED reasons=${reasons}; ${details}${reviewText}`,
    );
  }
  return [
    ...lines,
    ...renderOmission(pending.length - visible.length, 'review gate entries'),
  ];
}

function renderConcurrency(snapshot: TowerStatusConcurrency): string {
  const budget = Number.isFinite(snapshot.budget) ? String(snapshot.budget) : 'unlimited';
  const parts = [`budget: ${budget} agent(s) · inflight: ${String(snapshot.inflight)}`];
  if (snapshot.blockedUntil !== null) {
    const remainingMs = snapshot.blockedUntil - Date.now();
    parts.push(
      remainingMs > 0
        ? `spawns PAUSED for ~${String(Math.ceil(remainingMs / 1000))}s (provider rate limit — successful requests lift the pause early)`
        : 'spawn pause expired — budget probing resumes',
    );
  } else {
    parts.push('spawns open');
  }
  return parts.join(' · ');
}

function renderMissions(state: TowerStatusState, limit: number): string[] {
  if (state.missions.length === 0) return ['(no missions planned — use TowerPlan)'];
  const counts = new Map<TowerMission['status'], number>();
  for (const mission of state.missions) {
    counts.set(mission.status, (counts.get(mission.status) ?? 0) + 1);
  }
  const totals = [...counts]
    .map(([status, count]) => `${String(count)} ${status}`)
    .join(', ');
  const visible = state.missions.slice(-limit).toReversed();
  return [
    `Showing ${String(visible.length)} of ${String(state.missions.length)} mission(s), newest first.`,
    `Status totals: ${totals}.`,
    '',
    '| ID | Mission | Branch | Worktree | Status | Owner |',
    '| -- | ------- | ------ | -------- | ------ | ----- |',
    ...visible.map(
      (m) =>
        `| ${m.id} | ${m.title}${m.kind === 'survey' ? ' 🔍' : ''} | ${m.branch} | ${m.worktree} | ${STATUS_EMOJI[m.status]} ${m.status} | ${m.owner ?? '—'} |`,
    ),
    ...renderOmission(state.missions.length - visible.length, 'missions'),
  ];
}

function renderRoster(state: TowerStatusState, limit: number): string[] {
  if (state.roster.agents.length === 0) {
    return ['(no agents registered — spawn workers/reviewers with TowerSpawn)'];
  }
  const workers = state.roster.agents.filter((agent) => agent.kind === 'worker').length;
  const reviewers = state.roster.agents.length - workers;
  const visible = [...state.roster.agents]
    .toSorted((a, b) => b.spawnedAt.localeCompare(a.spawnedAt))
    .slice(0, limit);
  const lines = visible.map((a) => {
    const assignment =
      a.kind === 'worker'
        ? `mission ${a.missionId ?? '?'} (branch ${a.branch ?? '?'}, worktree ${a.worktree ?? '?'})`
        : `reviewing ${a.reviewTarget ?? '?'}`;
    const death = a.diedAt === undefined ? '' : ` — 💀 ${a.deathStatus ?? 'died'}`;
    return `- ${a.name} (${a.kind}) — agent ${a.agentId}, ${assignment}${death}`;
  });
  return [
    `Showing ${String(visible.length)} of ${String(state.roster.agents.length)} agent(s) (${String(workers)} workers, ${String(reviewers)} reviewers), newest spawned first.`,
    '',
    ...lines,
    ...renderOmission(state.roster.agents.length - visible.length, 'roster entries'),
  ];
}

function renderUnspawnedMissions(state: TowerStatusState, limit: number): string[] {
  const pending = state.missions.filter((m) => m.status === 'planned' && m.owner === undefined);
  if (pending.length === 0) return [];
  const visible = pending.slice(-limit).toReversed();
  return [
    '',
    '## Awaiting spawn',
    '',
    `Showing ${String(visible.length)} of ${String(pending.length)} planned mission(s), newest first.`,
    '',
    ...visible.map(
      (m) =>
        `- ${m.id} (${m.branch}) — planned but no worker spawned yet: launch one with TowerSpawn(kind="worker", mission_id="${m.id}", name="...")`,
    ),
    ...renderOmission(pending.length - visible.length, 'awaiting-spawn missions'),
  ];
}

function renderDeathWarnings(state: TowerStatusState, limit: number): string[] {
  const deadByName = new Map(
    state.roster.agents.filter((a) => a.diedAt !== undefined).map((a) => [a.name, a]),
  );
  const lines: string[] = [];
  for (const mission of state.missions) {
    if (mission.owner === undefined) continue;
    if (mission.status === 'merged' || mission.status === 'abandoned') continue;
    const entry = deadByName.get(mission.owner);
    if (entry === undefined) continue;
    lines.push(
      isStoppedByUser(entry)
        ? `- 🛑 ${mission.id} owner ${entry.name} was stopped by the user (${entry.deathStatus ?? 'unknown'}) — dead by intent: never resume it and do not reassign the mission unless the human asks`
        : entry.kind === 'reviewer'
          ? `- ⚠️ ${mission.id} reviewer ${entry.name} died (${entry.deathStatus ?? 'unknown'}) — diagnose first: check the death status/reason and task state. A reviewer is one-shot: do not resume it or another roster agent; after diagnosis, spawn a fresh reviewer only if the mission still needs one`
          : `- ⚠️ ${mission.id} owner ${entry.name} died (${entry.deathStatus ?? 'unknown'}) — diagnose first: check why it died (the died entry's status/reason, its task state) before reviving anything. Resume with Agent(resume="${entry.agentId}", run_in_background=true, prompt="...") (foreground only when background task tools are unavailable) or reassign the mission only when the cause is transient (lost contact, timeout, OOM); a systematic cause (code or environment defect) is fixed or escalated to the human before any revive`,
    );
  }
  if (lines.length === 0) return lines;
  const visible = lines.slice(-limit).toReversed();
  return [
    '',
    '## Dead workers',
    '',
    `Showing ${String(visible.length)} of ${String(lines.length)} death warning(s), newest mission first.`,
    '',
    ...visible,
    ...renderOmission(lines.length - visible.length, 'death warnings'),
  ];
}

function renderOmission(omitted: number, noun: string): string[] {
  if (omitted === 0) return [];
  return [
    '',
    `${String(omitted)} earlier ${noun} omitted; call TowerStatus with a larger limit to inspect them.`,
  ];
}

function isStoppedByUser(entry: TowerRosterEntry): boolean {
  return entry.deathReason?.trim() === userCancellationReason().message;
}

