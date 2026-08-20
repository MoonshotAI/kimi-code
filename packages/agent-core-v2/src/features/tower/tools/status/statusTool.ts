import { branchExists, branchTip } from '#/features/tower/protocol/index';
import type { TowerMission, TowerState, TowerStore } from '#/features/tower/protocol/index';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  ITowerRateLimitService,
  type TowerRateLimitSnapshot,
} from '#/features/tower/towerRateLimit';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './status.md?raw';
import {
  ITowerStatusTool,
  TowerStatusToolInputSchema,
  type TowerStatusToolInput,
} from './status';

const STATUS_EMOJI: Record<TowerMission['status'], string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
};

const INBOX_COUNT_LIMIT = 1000;
const RECENT_LOG_LINES = 10;

export class TowerStatusTool implements ITowerStatusTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerStatus' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerStatusToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ITowerRateLimitService private readonly rateLimit: ITowerRateLimitService,
  ) {}

  resolveExecution(_args: TowerStatusToolInput): ToolExecution {
    return {
      description: 'Reading tower status',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);

          const sections: string[] = [
            `# Tower status — base: ${state.base} (mode: ${state.mode}), you are: ${caller}`,
            '',
            '## Missions',
            '',
            ...renderMissions(state),
            '',
            '## Roster',
            '',
            ...renderRoster(state),
            '',
            '## Review gate (unmerged branches)',
            '',
            ...(await this.renderReviewGate(store, state)),
          ];

          if (
            state.missions.length > 0 &&
            state.missions.every((mission) => mission.status === 'merged')
          ) {
            sections.push(
              '',
              '## Done',
              '',
              'All missions are merged. Free the worktree checkouts now: run TowerTeardown (branches and .tower/comms/ are kept; dirty worktrees are protected).',
            );
          }

          const inbox = await store.readInbox(caller, INBOX_COUNT_LIMIT);
          sections.push(
            '',
            '## Inbox',
            '',
            `${String(inbox.length)} message(s) visible to you — read with TowerInbox.`,
            '',
            '## Concurrency (adaptive)',
            '',
            renderConcurrency(this.rateLimit.snapshot()),
            '',
            '## Recent activity',
            '',
          );
          const log = await store.recentLog(RECENT_LOG_LINES);
          sections.push(...(log.length > 0 ? log : ['(activity log is empty)']));
          return { output: sections.join('\n') };
        }),
    };
  }

  private async renderReviewGate(store: TowerStore, state: TowerState): Promise<string[]> {
    const pending = state.missions.filter((m) => m.status !== 'merged');
    if (pending.length === 0) return ['(all missions merged — or none planned yet)'];
    const lines: string[] = [];
    for (const mission of pending) {
      const review = await store.latestReview(mission.branch);
      if (review === undefined) {
        lines.push(`- ${mission.branch} (${mission.id}): no review yet`);
        continue;
      }
      const tip = (await branchExists(store.repoRoot, mission.branch))
        ? await branchTip(store.repoRoot, mission.branch)
        : undefined;
      const sync =
        tip === undefined
          ? 'branch not created yet'
          : tip === review.reviewedCommit
            ? 'reviewed commit matches tip'
            : `STALE — tip moved to ${tip.slice(0, 7)}, re-review required`;
      lines.push(
        `- ${mission.branch} (${mission.id}): round ${String(review.round)} by ${review.reviewer} — ${review.status} (${sync})`,
      );
    }
    return lines;
  }
}

function renderConcurrency(snapshot: TowerRateLimitSnapshot): string {
  const parts = [
    `budget: ${String(snapshot.budget)} agent(s) · inflight: ${String(snapshot.inflight)}`,
  ];
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

function renderMissions(state: TowerState): string[] {
  if (state.missions.length === 0) return ['(no missions planned — use TowerPlan)'];
  return [
    '| ID | Mission | Branch | Worktree | Status | Owner |',
    '| -- | ------- | ------ | -------- | ------ | ----- |',
    ...state.missions.map(
      (m) =>
        `| ${m.id} | ${m.title}${m.kind === 'survey' ? ' 🔍' : ''} | ${m.branch} | ${m.worktree} | ${STATUS_EMOJI[m.status]} ${m.status} | ${m.owner ?? '—'} |`,
    ),
  ];
}

function renderRoster(state: TowerState): string[] {
  if (state.roster.agents.length === 0) {
    return ['(no agents registered — spawn workers/reviewers with TowerSpawn)'];
  }
  return state.roster.agents.map((a) => {
    const assignment =
      a.kind === 'worker'
        ? `mission ${a.missionId ?? '?'} (branch ${a.branch ?? '?'}, worktree ${a.worktree ?? '?'})`
        : `reviewing ${a.reviewTarget ?? '?'}`;
    return `- ${a.name} (${a.kind}) — agent ${a.agentId}, ${assignment}`;
  });
}

