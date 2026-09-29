import { z } from 'zod';

import { type ToolDefinition } from '@moonshot-ai/agent-core';

import type { TowerRateLimitSnapshot } from '../rateLimit';
import type { TowerMission, TowerState, TowerStore } from '../protocol/index';

import DESCRIPTION from './status.md?raw';
import {
  callerName,
  errorText,
  newTowerStore,
  parseTowerArgs,
  runTowerTool,
  text,
  toInputJsonSchema,
  type TowerToolDeps,
} from './support';

export const TowerStatusToolInputSchema = z.object({}).strict();

export type TowerStatusToolInput = z.infer<typeof TowerStatusToolInputSchema>;

const STATUS_EMOJI: Record<TowerMission['status'], string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
  abandoned: '🚫',
};

const INBOX_COUNT_LIMIT = 1000;
const RECENT_LOG_LINES = 10;

export function createTowerStatusTool(deps: TowerToolDeps): ToolDefinition {
  const renderReviewGate = async (store: TowerStore, state: TowerState): Promise<string[]> => {
    const pending = state.missions.filter(
      (m) => m.status !== 'merged' && m.status !== 'abandoned',
    );
    if (pending.length === 0) return ['(no open missions — or none planned yet)'];
    const lines: string[] = [];
    for (const mission of pending) {
      const review = await store.latestReview(mission.branch);
      if (review === undefined) {
        lines.push(`- ${mission.branch} (${mission.id}): no review yet`);
        continue;
      }
      const tip = (await deps.io.git.branchExists(store.repoRoot, mission.branch))
        ? await deps.io.git.branchTip(store.repoRoot, mission.branch)
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
  };

  return {
    name: 'TowerStatus',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerStatusToolInputSchema),
    execute({ toolCall }) {
      const parsed = parseTowerArgs(TowerStatusToolInputSchema, toolCall.arguments, 'TowerStatus');
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      return runTowerTool(async () => {
        const store = newTowerStore(deps);
        const state = await store.load();
        const caller = callerName(deps.agentId, store, state);

        const sections: string[] = [
          `# Tower status — base: ${state.base} (mode: ${state.mode}), you are: ${caller}`,
          '',
          '## Missions',
          '',
          ...renderMissions(state),
          ...renderDeathWarnings(state),
          '',
          '## Roster',
          '',
          ...renderRoster(state),
          '',
          '## Review gate (unmerged branches)',
          '',
          ...(await renderReviewGate(store, state)),
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

        const inbox = await store.readInbox(caller, INBOX_COUNT_LIMIT);
        sections.push(
          '',
          '## Inbox',
          '',
          `${String(inbox.length)} message(s) visible to you — read with TowerInbox.`,
          '',
          '## Concurrency (adaptive)',
          '',
          renderConcurrency(deps.rateLimit.snapshot()),
          '',
          '## Recent activity',
          '',
        );
        const log = await store.recentLog(RECENT_LOG_LINES);
        sections.push(...(log.length > 0 ? log : ['(activity log is empty)']));
        return text(sections.join('\n'));
      });
    },
  };
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
    const death = a.diedAt === undefined ? '' : ` — 💀 ${a.deathStatus ?? 'died'}`;
    return `- ${a.name} (${a.kind}) — agent ${a.agentId}, ${assignment}${death}`;
  });
}

function renderDeathWarnings(state: TowerState): string[] {
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
      `- ⚠️ ${mission.id} owner ${entry.name} died (${entry.deathStatus ?? 'unknown'}) — recover with Agent(resume="${entry.agentId}", run_in_background=true, prompt="...") (never foreground: its output flows back through the tower protocol files) or reassign the mission`,
    );
  }
  if (lines.length === 0) return lines;
  return ['', '## Dead workers', '', ...lines];
}
