/**
 * TowerSpawnTool — the tower's worker/reviewer launcher. The prompt is
 * assembled here from the mission/review briefing (never by the tower LLM),
 * the agent runs detached in the background via SessionSubagentHost +
 * BackgroundManager (same pattern as the Agent tool), and the roster entry is
 * what lets the spawned agent use the tower comms tools.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Agent } from '#/agent';
import { z } from 'zod';

import { AgentBackgroundTask, type BackgroundManager } from '../../../agent/background';
import { MISSIONS_DIR, TOWER_NAME, WORKTREES_DIR, missionFileName } from '../../../agent/tower';
import type { TowerMission, TowerState, TowerStore } from '../../../agent/tower';
import type { BuiltinTool } from '../../../agent/tool';
import { SECONDARY_DERIVED_MODEL_ALIAS } from '../../../config';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '../../../loop/types';
import { towerRateLimiter } from '../../../loop/rate-limiter';
import { resolveSubagentBinding } from '../../../session/subagent-binding';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type SessionSubagentHost,
  type SubagentHandle,
} from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import { newStore, runTowerTool } from './support';

export const TowerSpawnToolInputSchema = z
  .object({
    name: z
      .string()
      .describe(
        'Unique tower name for the agent (e.g. "agent-build", "reviewer-a"). Used for inbox addressing and mission ownership.',
      ),
    kind: z
      .enum(['worker', 'reviewer'])
      .describe('workers execute a mission in their worktree; reviewers review one branch'),
    mission_id: z
      .string()
      .optional()
      .describe('Required for workers: the mission id (e.g. "M1") from TowerPlan'),
    review_target: z
      .string()
      .optional()
      .describe('Required for reviewers: the branch to review (e.g. "feat/vulkan-build")'),
    instructions: z
      .string()
      .optional()
      .describe('Extra tower instructions appended to the generated briefing'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'worker' && (value.mission_id ?? '').trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mission_id'],
        message: 'worker spawns require mission_id',
      });
    }
    if (value.kind === 'reviewer' && (value.review_target ?? '').trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['review_target'],
        message: 'reviewer spawns require review_target',
      });
    }
  });

export type TowerSpawnToolInput = z.infer<typeof TowerSpawnToolInputSchema>;

export class TowerSpawnTool implements BuiltinTool<TowerSpawnToolInput> {
  readonly name = 'TowerSpawn' as const;
  readonly description: string = `Spawn a tower worker or reviewer as a background subagent and register it in the tower roster.

Workers: pass mission_id — the tool creates the mission worktree, marks the mission active with this worker as owner, and briefs the agent with the full mission text. Reviewers: pass review_target — the agent gets a review checklist and must submit its verdict via TowerReview.

The briefing prompt is assembled by this tool (worktree path, scope, protocol rules); use instructions only for extra context. If the name is already registered, resume the existing agent with the Agent tool instead of spawning a duplicate.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerSpawnToolInputSchema);

  constructor(
    private readonly agent: Agent,
    private readonly subagentHost: SessionSubagentHost,
    private readonly backgroundManager: BackgroundManager,
  ) {}

  resolveExecution(args: TowerSpawnToolInput): ToolExecution {
    return {
      description: `Spawning tower ${args.kind} "${args.name}"`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: TowerSpawnToolInput,
    { toolCallId }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    return runTowerTool(async () => {
      if (!this.agent.towerMode.isActive) {
        return {
          output: 'tower mode is not active — run TowerInit first',
          isError: true,
        };
      }
      const store = newStore(this.agent);
      const state = await store.load();

      const existing = store.findByName(state, args.name);
      if (existing !== undefined) {
        return {
          output:
            `tower agent "${args.name}" is already registered (agent_id: ${existing.agentId}, kind: ${existing.kind}) — ` +
            `resume it instead of spawning a duplicate: Agent(resume="${existing.agentId}", prompt="...")`,
          isError: true,
        };
      }

      const notes: string[] = [];
      let mission: TowerMission | undefined;
      let reviewTarget: string | undefined;
      if (args.kind === 'worker') {
        const missionId = args.mission_id;
        if (missionId === undefined) {
          return { output: 'worker spawns require mission_id', isError: true };
        }
        mission = state.missions.find((m) => m.id === missionId);
        if (mission === undefined) {
          const known = state.missions.map((m) => m.id).join(', ');
          return {
            output: `unknown mission "${missionId}" — known missions: ${known.length > 0 ? known : '(none planned yet)'}`,
            isError: true,
          };
        }
        try {
          await store.addWorktree(mission.worktree, mission.branch, state.base);
        } catch (error) {
          // The worktree may already exist (e.g. respawn after a crash) — the
          // agent can still work in it; surface the git message and continue.
          notes.push(
            `worktree setup warning (continuing): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // Silent: the spawn log line below already carries name/owner/mission —
        // a second mission.update line for the same assignment is pure noise.
        await store.updateMission(
          TOWER_NAME,
          mission.id,
          { status: 'active', owner: args.name },
          { silent: true },
        );
      } else {
        reviewTarget = args.review_target;
        if (reviewTarget === undefined) {
          return { output: 'reviewer spawns require review_target', isError: true };
        }
      }

      const prompt = await this.buildPrompt(args, store, state, mission, reviewTarget);
      const description =
        mission !== undefined
          ? `tower worker ${args.name}: ${mission.title}`
          : `tower reviewer ${args.name}: ${reviewTarget ?? ''}`;

      // Adaptive concurrency gate: refused while the provider is rate-limiting
      // (pause) or the inflight budget is exhausted. The slot is released when
      // the agent's completion settles — or immediately on a launch failure.
      const gate = towerRateLimiter.acquire();
      if (!gate.ok) {
        return { output: gate.reason, isError: true };
      }
      let slotHeld = true;
      try {
        const controller = new AbortController();
        let handle: SubagentHandle;
        try {
          handle = await this.subagentHost.spawn({
            profileName: 'tower-worker',
            prompt,
            description,
            parentToolCallId: toolCallId,
            runInBackground: true,
            signal: controller.signal,
            // Reviewers stay on the tower's (primary) model — review quality
            // is not where the secondary model saves money.
            modelChoice: args.kind === 'reviewer' ? 'primary' : undefined,
            // Workers are confined to their worktree (cwd override): relative
            // paths land there and the write guard rejects anything outside.
            // Reviewers stay on the main checkout — their work is read-only.
            cwd:
              mission !== undefined
                ? store.abs(join(WORKTREES_DIR, mission.worktree))
                : undefined,
          });
        } catch (error) {
          return {
            output: `tower spawn failed: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }

        let taskId: string;
        try {
          taskId = this.backgroundManager.registerTask(
            new AgentBackgroundTask(handle, description, this.subagentHost, controller),
            {
              detached: true,
              timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
              signal: undefined,
            },
          );
        } catch (error) {
          controller.abort();
          void handle.completion.catch(() => {});
          return {
            output: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
        void handle.completion
          .catch(() => {})
          .finally(() => {
            towerRateLimiter.release();
          });
        slotHeld = false;

        // Display-only resolution — the host already resolved (and validated)
        // the same binding inside spawn(); surface it in the log and output.
        const spawnBinding = resolveSubagentBinding(
          this.agent.kimiConfig,
          this.agent.experimentalFlags,
          {
            modelAlias: this.agent.config.modelAlias,
            thinkingEffort: this.agent.config.thinkingEffort,
          },
          args.kind === 'reviewer' ? 'primary' : undefined,
        );
        const boundModel =
          spawnBinding.modelAlias === undefined
            ? undefined
            : spawnBinding.modelAlias === SECONDARY_DERIVED_MODEL_ALIAS
              ? (this.agent.kimiConfig?.secondaryModel?.model ?? spawnBinding.modelAlias)
              : spawnBinding.modelAlias;

        await store.registerAgent({
          name: args.name,
          agentId: handle.agentId,
          kind: args.kind,
          missionId: mission?.id,
          reviewTarget,
          worktree: mission?.worktree,
          branch: mission?.branch,
          spawnedAt: new Date().toISOString(),
        });
        await store.appendLog(
          TOWER_NAME,
          'spawn',
          {
            name: args.name,
            kind: args.kind,
            agent: handle.agentId,
            mission: mission?.id,
            target: reviewTarget,
            model: boundModel,
          },
          mission !== undefined
            ? join(MISSIONS_DIR, missionFileName(mission.id, mission.slug))
            : undefined,
        );

        return {
          output: [
            `name: ${args.name}`,
            `kind: ${args.kind}`,
            `agent_id: ${handle.agentId}`,
            `task_id: ${taskId}`,
            'status: running',
            ...(boundModel !== undefined ? [`model: ${boundModel}`] : []),
            ...(mission !== undefined
              ? [
                  `mission: ${mission.id} — ${mission.title}`,
                  `branch: ${mission.branch}`,
                  `worktree: ${store.abs(join(WORKTREES_DIR, mission.worktree))}`,
                ]
              : [`review_target: ${reviewTarget ?? ''}`]),
            ...notes,
            '',
            `The ${args.kind} runs detached in the background; its completion arrives as a notification. Track progress with TowerStatus / TowerInbox; recover a dead agent with Agent(resume="${handle.agentId}", prompt="...").`,
          ].join('\n'),
        };
      } finally {
        if (slotHeld) towerRateLimiter.release();
      }
    });
  }

  /** Briefings are code-assembled — the tower LLM only supplies `instructions`. */
  private async buildPrompt(
    args: TowerSpawnToolInput,
    store: TowerStore,
    state: TowerState,
    mission: TowerMission | undefined,
    reviewTarget: string | undefined,
  ): Promise<string> {
    const extra =
      args.instructions !== undefined && args.instructions.trim().length > 0
        ? `\n\n# Additional instructions from the tower\n${args.instructions.trim()}`
        : '';
    if (mission !== undefined) {
      const missionText = await readFile(
        store.abs(join(MISSIONS_DIR, missionFileName(mission.id, mission.slug))),
        'utf8',
      );
      const worktreeAbs = store.abs(join(WORKTREES_DIR, mission.worktree));
      const workplace =
        `# Your workplace\n` +
        `- Your private git worktree: ${worktreeAbs}\n` +
        `- Your branch: ${mission.branch} (base: ${state.base})\n` +
        `- Your working directory IS the worktree — every relative path resolves inside it, and a permission guard hard-denies any Write/Edit outside it. Never touch the main checkout (${store.repoRoot}) or another agent's worktree slot, not even with absolute paths.\n` +
        (mission.kind === 'survey'
          ? `- Scope — what you investigate (read-only; reserves nothing): ${mission.scope.join(', ')}\n\n`
          : `- Scope — the only files you may change: ${mission.scope.join(', ')}\n\n`);
      if (mission.kind === 'survey') {
        return (
          `You are "${args.name}", a tower worker agent in a multi-agent workspace, assigned a READ-ONLY survey mission.\n\n` +
          workplace +
          `# Your mission\n\n${missionText.trim()}\n\n` +
          `# Read-only discipline\n` +
          '- Your scope marks what you investigate, not what you may change. You MUST NOT modify, add, or delete any file in the repo, and your branch must end with zero commits — a changed file makes the merge gate reject your mission as a read-only violation.\n' +
          '- Your deliverables are knowledge: record findings as TowerMission notes, send summaries to the tower and to dependent agents with TowerSend, and file TowerFinding for out-of-scope discoveries.\n\n' +
          `# Communication protocol\n` +
          '- Coordinate through tower tools ONLY: TowerSend / TowerInbox / TowerFinding / TowerMission / TowerStatus. Reach the tower and sibling agents with TowerSend; check TowerInbox regularly.\n' +
          '- NEVER create or edit files under `.tower/` by hand — the tools are the only writers.\n\n' +
          `# When the survey is done\n` +
          `1. Mark the mission completed: TowerMission(id="${mission.id}", status="completed").\n` +
          '2. Send the tower your summary: TowerSend(to="tower", subject="survey-summary", body=the full survey result).\n' +
          '3. Finish with a structured final summary: what you covered, key facts with file:line references, open questions.' +
          extra
        );
      }
      return (
        `You are "${args.name}", a tower worker agent in a multi-agent workspace.\n\n` +
        workplace +
        `# Your mission\n\n${missionText.trim()}\n\n` +
        `# Communication protocol\n` +
        '- Coordinate through tower tools ONLY: TowerSend / TowerInbox / TowerFinding / TowerMission / TowerStatus. Reach the tower and sibling agents with TowerSend; check TowerInbox regularly.\n' +
        '- NEVER create or edit files under `.tower/` by hand — the tools are the only writers; hand-written protocol files break the merge gate.\n' +
        '- Found something notable outside your scope? File it with TowerFinding instead of fixing it.\n' +
        '- Keep your mission current with TowerMission: task_done as you finish tasks, note for decisions, blocker when stuck.\n\n' +
        `# When the mission is done\n` +
        '1. `git add` + `git commit` everything in your worktree (and `git push` only if a remote is configured).\n' +
        `2. Mark the mission completed: TowerMission(id="${mission.id}", status="completed").\n` +
        '3. Request review: TowerSend(to="tower", subject="review-request", body=what you changed and why).\n' +
        '4. Finish with a structured final summary: files changed, key decisions, open follow-ups.' +
        extra
      );
    }
    const target = reviewTarget ?? '';
    const author = state.missions.find((m) => m.branch === target)?.owner;
    return (
      `You are "${args.name}", a tower reviewer agent in a multi-agent workspace.\n\n` +
      `# Your assignment\n` +
      `Review branch "${target}" against base "${state.base}".\n` +
      `- Work read-only in the main checkout (${store.repoRoot}): \`git diff ${state.base}...${target}\`, \`git log ${state.base}..${target}\`, and read files as needed.\n` +
      '- Do NOT modify any code, and never create or edit files under `.tower/` by hand — protocol artifacts go through the tower tools.\n\n' +
      `# Review checklist (in priority order)\n` +
      '1. Security\n2. Data integrity\n3. Performance\n4. Error handling\n5. Code quality\n\n' +
      `# When done — both steps are mandatory\n` +
      `1. Submit your verdict with TowerReview: { target: "${target}", status: "clean" | "p1-Nitems" | "p2-Nitems", merge: "merge" | "fix-then-merge" | "hold", findings, checks, decision }. Only a "clean" review of the exact branch tip lets the tower merge.\n` +
      (author !== undefined
        ? `2. Notify the author with TowerSend(to="${author}", subject="review-result", ...).\n`
        : '2. The author of this branch is not recorded — notify the tower instead: TowerSend(to="tower", subject="review-result", ...).\n') +
      'Then finish with a structured summary of the review.' +
      extra
    );
  }
}
