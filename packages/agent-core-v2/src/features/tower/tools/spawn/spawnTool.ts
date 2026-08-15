/**
 * `tools` domain — `TowerSpawnTool` implementation (the `TowerSpawn` tool).
 *
 * The tower's worker/reviewer launcher, ported from v1
 * (`agent-core/src/tools/builtin/tower/spawn.ts`) onto v2's spawn composition:
 * the briefing prompt is assembled here from the mission/review briefing
 * (never by the tower LLM), the roster/worktree/mission bookkeeping goes
 * through `TowerStore` (`tower` domain protocol), the agent is created
 * through `IAgentLifecycleService` with the `tower-worker` profile and driven
 * via `ISessionSubagentService.run` mirrored onto the tower's record stream
 * (`mirrorAgentRun`), and the run is registered detached with
 * `IAgentTaskService` under a `SubagentTask` — the same background path as
 * the `Agent` tool. Spawn concurrency is gated by `ITowerRateLimitService`;
 * the slot is released when the agent's completion settles (or immediately on
 * a launch/registration failure). The worker's model binding follows the same
 * rule as the `Agent`/`AgentSwarm` tools (`resolveSubagentBinding`): the
 * configured secondary model while the secondary-model experiment is on,
 * otherwise the tower's own model — except reviewers, who always bind the
 * tower's (primary) model. The resolved model is reported in the tool output
 * and the `spawn` line of the tower activity log. The spawned agent is pinned
 * to the `auto` permission mode regardless of the tower's own mode: workers
 * and reviewers run detached and unattended, so per-call approval prompts
 * would serialize the fleet on the user's attention (and with no approval
 * broker attached they silently auto-approve anyway). User-configured deny
 * rules and the tower-worker write guard still apply — both adjudicate
 * independently of the mode. `broadcastPermissionMode` skips
 * `tower-worker`-profile agents, so a later session-wide mode switch does not
 * move them off `auto` either.
 *
 * Deliberate v2 adaptation — no per-agent cwd: v1 confined each worker by
 * overriding its process cwd to the worktree. v2 freezes the session cwd by
 * design (every agent shares it), so confinement is instead (a) briefed —
 * `buildPrompt` states the worker's absolute worktree path and instructs it
 * to address every file operation (and every Bash `cd`) at that path — and
 * (b) enforced — the tower-worker write guard in `towerService.ts` hard-denies
 * Write/Edit outside the roster-recorded worktree. `buildPrompt` is otherwise
 * a verbatim v1 port; only the cwd-relative phrasing changed.
 *
 * Registered main-only (the tower) by `towerFeature.ts`. Bound at Agent
 * scope.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentTaskService } from '#/agent/task/task';
import {
  GitError,
  MISSIONS_DIR,
  TOWER_NAME,
  TowerProtocolError,
  TowerStore,
  WORKTREES_DIR,
  missionFileName,
  resolveTowerRepoRoot,
  type TowerMission,
  type TowerState,
} from '#/features/tower/protocol/index';
import { IAgentTowerService, TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { ITowerRateLimitService } from '#/features/tower/towerRateLimit';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { subagentLabels } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  resolveSubagentBinding,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import { SubagentTask, type SubagentHandle } from '#/agent/tools/agent/subagent-task';

import { ITowerSpawnTool, TowerSpawnToolInputSchema, type TowerSpawnToolInput } from './spawn';
import DESCRIPTION from './spawn.md?raw';

type SubagentBinding = ReturnType<typeof resolveSubagentBinding>;

export class TowerSpawnTool implements ITowerSpawnTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerSpawn' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerSpawnToolInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @ITowerRateLimitService private readonly rateLimit: ITowerRateLimitService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: TowerSpawnToolInput): ToolExecution {
    return {
      description: `Spawning tower ${args.kind} "${args.name}"`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private newStore(): TowerStore {
    return new TowerStore(resolveTowerRepoRoot(this.sessionContext.cwd));
  }

  private async execution(
    args: TowerSpawnToolInput,
    { toolCallId }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      if (!this.tower.isActive) {
        return {
          output: 'tower mode is not active — run TowerInit first',
          isError: true,
        };
      }
      const store = this.newStore();
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
      const gate = this.rateLimit.acquire();
      if (!gate.ok) {
        return { output: gate.reason, isError: true };
      }
      let slotHeld = true;
      try {
        const controller = new AbortController();
        // The same binding rule as the Agent/AgentSwarm tools: the configured
        // secondary model when the experiment is on, otherwise inherit the
        // tower's own model. Reviewers are the exception — they always bind
        // the tower's (primary) model: review quality is not where the
        // secondary model saves money.
        const own = this.profile.data();
        const binding =
          own.modelAlias === undefined
            ? undefined
            : resolveSubagentBinding(
                this.config,
                this.flags,
                { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
                args.kind === 'reviewer' ? 'primary' : undefined,
              );
        let handle: SubagentHandle;
        try {
          handle = await this.launch(prompt, description, toolCallId, controller, binding);
        } catch (error) {
          return {
            output: `tower spawn failed: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }

        let taskId: string;
        try {
          taskId = this.tasks.registerTask(new SubagentTask(handle, description, controller), {
            detached: true,
            timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
            signal: undefined,
          });
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
            this.rateLimit.release();
          });
        slotHeld = false;

        await store.registerAgent({
          name: args.name,
          agentId: handle.agentId,
          sessionId: this.sessionContext.sessionId,
          kind: args.kind,
          missionId: mission?.id,
          reviewTarget,
          worktree: mission?.worktree,
          branch: mission?.branch,
          spawnedAt: new Date().toISOString(),
        });
        if (mission !== undefined) {
          // Only once the spawn is real (gate passed, task registered, roster
          // written): marking the mission active+owned any earlier would leave
          // a phantom owner behind when the gate or the launch fails. Silent:
          // the spawn log line below already carries name/owner/mission — a
          // second mission.update line for the same assignment is pure noise.
          await store.updateMission(
            TOWER_NAME,
            mission.id,
            { status: 'active', owner: args.name },
            { silent: true },
          );
        }
        await store.appendLog(
          TOWER_NAME,
          'spawn',
          {
            name: args.name,
            kind: args.kind,
            agent: handle.agentId,
            mission: mission?.id,
            target: reviewTarget,
            model: binding?.model,
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
            ...(binding !== undefined ? [`model: ${binding.model}`] : []),
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
        if (slotHeld) this.rateLimit.release();
      }
    } catch (error) {
      // Expected protocol/git failures surface as error results — their
      // messages are written as next-step guidance for the model. Unexpected
      // (programming) errors keep propagating.
      if (error instanceof TowerProtocolError || error instanceof GitError) {
        return { output: error.message, isError: true };
      }
      throw error;
    }
  }

  private async launch(
    prompt: string,
    description: string,
    toolCallId: string,
    controller: AbortController,
    binding: SubagentBinding | undefined,
  ): Promise<SubagentHandle> {
    const requester = this.lifecycle.get(this.callerAgentId);
    if (requester === undefined) {
      throw new Error(`Caller agent "${this.callerAgentId}" does not exist`);
    }

    let created: IAgentScopeHandle;
    try {
      // Validate the bound alias up front so a dangling [secondary_model]
      // pointer fails the spawn here, not mid-turn inside the worker.
      if (binding !== undefined) this.modelCatalog.get(binding.model);
      created = await this.lifecycle.create({
        binding: {
          profile: TOWER_WORKER_PROFILE,
          model: binding?.model,
          thinking: binding?.thinking,
        },
        labels: subagentLabels(this.callerAgentId),
      });
    } catch (error) {
      throw binding === undefined
        ? error
        : wrapSubagentModelError(error, binding.model, this.profile.data().modelAlias);
    }
    // Pin the spawned agent to auto (see the file header): the fleet runs
    // unattended, and broadcastPermissionMode will not move it off auto later.
    created.accessor.get(IAgentPermissionModeService).setMode('auto');
    const agentId = created.id;

    emitAgentRunSpawned(requester, agentId, {
      profileName: TOWER_WORKER_PROFILE,
      parentToolCallId: toolCallId,
      description,
      runInBackground: true,
    });

    const run = await this.subagents.run(
      agentId,
      { kind: 'prompt', prompt },
      { signal: controller.signal },
    );
    const mirrored = mirrorAgentRun(requester, run, {
      profileName: TOWER_WORKER_PROFILE,
      prompt,
      signal: controller.signal,
      cancel: (reason) => {
        controller.abort(reason);
      },
    });
    return {
      agentId,
      profileName: TOWER_WORKER_PROFILE,
      completion: mirrored.then((r) => ({ result: r.summary, usage: r.usage })),
    };
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
        `- Your working directory is the main checkout, NOT your worktree — address the worktree explicitly: every Read/Write/Edit/Grep/Glob path must be absolute and under ${worktreeAbs}, and every Bash command must \`cd ${worktreeAbs}\` first. A permission guard hard-denies any Write/Edit outside it. Never touch the main checkout (${store.repoRoot}) or another agent's worktree slot.\n` +
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

