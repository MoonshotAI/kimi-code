import { z } from 'zod';

import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';
import {
  createUserEntry,
  type AssistantMeta,
  type HistoryMessage,
} from '@moonshot-ai/agent-core/history/index';
import { addUsage } from '@moonshot-ai/agent-core/history/usage';
import { createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LlmModelSpec } from '@moonshot-ai/agent-core/llm/request';
import type { TokenUsage } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester, TurnOutcome } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import { join } from 'pathe';

import type { PermissionFace } from '#/features/permission/index';

import {
  GitError,
  MISSIONS_DIR,
  missionFileName,
  resolveMissionByBranch,
  TOWER_NAME,
  TowerProtocolError,
  TowerStore,
  WORKTREES_DIR,
  isReservedTowerAgentName,
  type TowerMission,
  type TowerState,
} from '../protocol/index';
import { TOWER_WORKER_PROFILE } from '../ops';
import { TOWER_WORKER_PROFILE_DEF } from '../workerProfile';

import DESCRIPTION from './spawn.md?raw';
import {
  errorText,
  newTowerStore,
  parseTowerArgs,
  text,
  toInputJsonSchema,
  TOWER_MAIN_AGENT_ONLY,
  TOWER_MODE_USER_ENABLED_ONLY,
  type TowerToolDeps,
} from './support';

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
        code: 'custom',
        path: ['mission_id'],
        message: 'worker spawns require mission_id',
      });
    }
    if (value.kind === 'reviewer' && (value.review_target ?? '').trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['review_target'],
        message: 'reviewer spawns require review_target',
      });
    }
  });

export type TowerSpawnToolInput = z.infer<typeof TowerSpawnToolInputSchema>;

export interface SpawnModelEntry {
  readonly name: string;
  readonly description?: string;
  readonly model: LlmModelSpec;
}

export type SpawnModelResolution =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'explicit'; readonly name: string; readonly model: LlmModelSpec };

export interface SpawnRecord {
  readonly parentAgentId: string;
  readonly profileName: string;
  running: boolean;
}

export type SpawnRegistry = Map<string, SpawnRecord>;

export const SPAWN_SOURCE_PREFIX = 'spawn:';

export const SUBAGENT_STOPPED_MESSAGE = 'The subagent was stopped before it finished.';

export const MODEL_NOT_CONFIGURED_MESSAGE = 'Caller agent has no model bound.';

export function spawnSource(parentAgentId: string, profileName: string): string {
  return `${SPAWN_SOURCE_PREFIX}${parentAgentId}:${profileName}`;
}

export interface TowerSpawnToolDeps extends TowerToolDeps {
  readonly session: Session;
  readonly fire: (event: RuntimeEvent) => void;
  readonly models: readonly SpawnModelEntry[];
  readonly registry: SpawnRegistry;
  readonly running: Set<string>;
  readonly openSubagent: (
    agentId: string,
    init: {
      readonly systemPrompt: string;
      readonly source: string;
      readonly requester?: LoopLlmRequester;
    },
  ) => Promise<Agent>;
  readonly parentRequester: () => LoopLlmRequester | undefined;
  readonly permissionFor: (agent: Agent) => PermissionFace | undefined;
}

const REVIEW_REQUEST_SCAN_LIMIT = 50;

export function createTowerSpawnTool(deps: TowerSpawnToolDeps): ToolDefinition {
  const callerAgentId = deps.agentId;

  const buildPrompt = async (
    args: TowerSpawnToolInput,
    store: TowerStore,
    state: TowerState,
    mission: TowerMission | undefined,
    reviewTarget: string | undefined,
  ): Promise<string> => {
    const extra =
      args.instructions !== undefined && args.instructions.trim().length > 0
        ? `\n\n# Additional instructions from the tower\n${args.instructions.trim()}`
        : '';
    if (mission !== undefined) {
      const missionText = await deps.io.fs.readText(
        store.abs(join(MISSIONS_DIR, missionFileName(mission.id, mission.slug))),
      );
      const worktreeAbs = store.abs(join(WORKTREES_DIR, mission.worktree));
      const workplace =
        `# Your workplace\n` +
        `- Your private git worktree: ${worktreeAbs}\n` +
        `- Your branch: ${mission.branch} (base: ${state.base})\n` +
        (mission.spawnBase !== undefined
          ? `- Your branch starts from snapshot commit ${mission.spawnBase.slice(0, 7)}: the base checkout's uncommitted changes (WIP), captured at spawn so you can build on them. That commit is your foundation — never revert, amend, or claim it as your own work; your own commits go on top of it.\n`
          : '') +
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
          '- NEVER create or edit files under `.tower/` by hand — the tools are the only writers.\n' +
          '- Ambiguity is escalated, not guessed: if the mission leaves substantive doubt about what to investigate, TowerSend(to="tower", subject="clarify-request", body=what needs pinning down) BEFORE acting — the tower relays to the human; you never ask the user directly.\n\n' +
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
        '- Keep your mission current with TowerMission: task_done as you finish tasks, note for decisions, blocker when stuck.\n' +
        '- Ambiguity is escalated, not guessed: if the mission and its Context leave substantive doubt about what to build, TowerSend(to="tower", subject="clarify-request", body=what needs pinning down) BEFORE acting — the tower relays to the human; you never ask the user directly.\n\n' +
        `# When the mission is done\n` +
        '1. `git add` + `git commit` everything in your worktree (and `git push` only if a remote is configured).\n' +
        `2. Mark the mission completed: TowerMission(id="${mission.id}", status="completed").\n` +
        '3. Request review: TowerSend(to="tower", subject="review-request", body=what you changed and why, reconciled against the mission tasks item by item — the reviewer maps each task to your diff).\n' +
        '4. Finish with a structured final summary: files changed, key decisions, open follow-ups.' +
        extra
      );
    }
    const target = reviewTarget ?? '';
    const targetMission = resolveMissionByBranch(state, target);
    const author = targetMission?.owner;
    const reviewBase =
      targetMission !== undefined ? await store.diffBase(state, targetMission) : state.base;
    const missionSection =
      targetMission !== undefined
        ? `# Mission under review — verify the diff against this intent, not only against code health\n\n${(
            await deps.io.fs.readText(
              store.abs(join(MISSIONS_DIR, missionFileName(targetMission.id, targetMission.slug))),
            )
          ).trim()}\n\n`
        : '';
    const reviewRequest =
      author !== undefined
        ? (await store.readInbox(TOWER_NAME, REVIEW_REQUEST_SCAN_LIMIT)).find(
            (item) => item.from === author && item.subject.startsWith('review-request'),
          )
        : undefined;
    const selfReportSection =
      reviewRequest !== undefined
        ? `# The author's own account (their review-request to the tower)\n${reviewRequest.body.trim()}\n\n`
        : '';
    const checklist =
      targetMission !== undefined
        ? '1. Intent — does the diff deliver the mission above? Map every task to the changes; healthy code that answers the wrong requirement or silently drops a task is a finding, not a pass.\n2. Security\n3. Data integrity\n4. Performance\n5. Error handling\n6. Code quality\n\n'
        : '1. Security\n2. Data integrity\n3. Performance\n4. Error handling\n5. Code quality\n\n';
    return (
      `You are "${args.name}", a tower reviewer agent in a multi-agent workspace.\n\n` +
      `# Your assignment\n` +
      `Review branch "${target}" against base "${reviewBase}".\n` +
      `- Work read-only in the main checkout (${store.repoRoot}): \`git diff ${reviewBase}...${target}\`, \`git log ${reviewBase}..${target}\`, and read files as needed.\n` +
      '- Do NOT modify any code, and never create or edit files under `.tower/` by hand — protocol artifacts go through the tower tools.\n\n' +
      missionSection +
      selfReportSection +
      `# Review checklist (in priority order)\n` +
      checklist +
      `# When done — both steps are mandatory\n` +
      `1. Submit your verdict with TowerReview: { target: "${target}", status: "clean" | "p1-Nitems" | "p2-Nitems", merge: "merge" | "fix-then-merge" | "hold", findings, checks, decision }. Only a "clean" review of the exact branch tip lets the tower merge.\n` +
      (author !== undefined
        ? `2. Notify the author with TowerSend(to="${author}", subject="review-result", ...).\n`
        : '2. The author of this branch is not recorded — notify the tower instead: TowerSend(to="tower", subject="review-result", ...).\n') +
      'Then finish with a structured summary of the review.' +
      extra
    );
  };

  return {
    name: 'TowerSpawn',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerSpawnToolInputSchema),
    async execute({ toolCall, signal, detach }) {
      if (callerAgentId !== MAIN_AGENT_ID) {
        return errorText(TOWER_MAIN_AGENT_ONLY);
      }
      const parsed = parseTowerArgs(TowerSpawnToolInputSchema, toolCall.arguments, 'TowerSpawn');
      if ('parseError' in parsed) return errorText(parsed.parseError);
      const args = parsed.args;
      try {
        if (!deps.isActive()) {
          return errorText(TOWER_MODE_USER_ENABLED_ONLY);
        }
        const store = newTowerStore(deps);
        const state = await store.load();

        if (args.name.trim().length === 0 || args.name.trim() !== args.name) {
          return errorText(
            `tower agent name "${args.name}" must not be blank or carry surrounding whitespace`,
          );
        }

        if (isReservedTowerAgentName(args.name)) {
          return errorText(
            `tower agent name "${args.name}" is reserved by the tower protocol — pick a different name`,
          );
        }

        const existing = store.findByName(state, args.name);
        if (existing !== undefined) {
          return errorText(
            `tower agent "${args.name}" is already registered (agent_id: ${existing.agentId}, kind: ${existing.kind}) — ` +
              `resume it instead of spawning a duplicate: Agent(resume="${existing.agentId}", run_in_background=true, prompt="...") — never foreground: its output flows back through the tower protocol files`,
          );
        }

        const notes: string[] = [];
        let mission: TowerMission | undefined;
        let reviewTarget: string | undefined;
        if (args.kind === 'worker') {
          const missionId = args.mission_id;
          if (missionId === undefined) {
            return errorText('worker spawns require mission_id');
          }
          mission = state.missions.find((m) => m.id === missionId);
          if (mission === undefined) {
            const known = state.missions.map((m) => m.id).join(', ');
            return errorText(
              `unknown mission "${missionId}" — known missions: ${known.length > 0 ? known : '(none planned yet)'}`,
            );
          }
          try {
            const added = await store.addWorktree(mission.worktree, mission.branch, state.base);
            if (added.spawnBase !== undefined) {
              await store.updateMission(TOWER_NAME, mission.id, { spawnBase: added.spawnBase }, { silent: true });
              mission = { ...mission, spawnBase: added.spawnBase };
              notes.push(
                `base snapshot: ${added.spawnBase.slice(0, 7)} — the base checkout had uncommitted changes; they are committed as the branch's first commit (the checkout itself was left untouched)`,
              );
            }
          } catch (error) {
            if (error instanceof TowerProtocolError) throw error;
            notes.push(
              `worktree setup warning (continuing): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else {
          reviewTarget = args.review_target;
          if (reviewTarget === undefined) {
            return errorText('reviewer spawns require review_target');
          }
        }

        const prompt = await buildPrompt(args, store, state, mission, reviewTarget);
        const description =
          mission !== undefined
            ? `tower worker ${args.name}: ${mission.title}`
            : `tower reviewer ${args.name}: ${reviewTarget ?? ''}`;

        const gate = deps.rateLimit.acquire();
        if (!gate.ok) {
          return errorText(gate.reason);
        }
        let slotHeld = true;
        try {
          const model: SpawnModelResolution =
            args.kind === 'worker' && deps.models.length > 0
              ? { kind: 'explicit', name: deps.models[0]!.name, model: deps.models[0]!.model }
              : { kind: 'inherit' };
          const parentRequester = deps.parentRequester();
          if (model.kind === 'explicit' && parentRequester === undefined) {
            return errorText(`tower spawn failed: ${MODEL_NOT_CONFIGURED_MESSAGE}`);
          }
          const agentId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
          let launched: Agent;
          try {
            launched = await deps.openSubagent(agentId, {
              systemPrompt: TOWER_WORKER_PROFILE_DEF.systemPrompt,
              source: spawnSource(callerAgentId, TOWER_WORKER_PROFILE),
              requester:
                model.kind === 'explicit'
                  ? parentRequester!.with({ model: { spec: model.model } })
                  : undefined,
            });
          } catch (error) {
            return errorText(
              `tower spawn failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const permission = deps.permissionFor(launched);
          if (permission !== undefined) {
            await permission.setMode('auto').catch(() => {});
          }
          deps.registry.set(agentId, {
            parentAgentId: callerAgentId,
            profileName: TOWER_WORKER_PROFILE,
            running: true,
          });
          deps.running.add(agentId);
          deps.fire({
            type: 'tower.spawned',
            agentId,
            parentAgentId: callerAgentId,
            name: args.name,
            kind: args.kind,
            profile: TOWER_WORKER_PROFILE,
            description,
            model: model.kind === 'explicit' ? model.name : undefined,
            background: true,
          });
          const historyBefore = launched.view.getState().messages.length;
          const finish = async (
            outcome: TurnOutcome,
          ): Promise<{ readonly died?: { status: string; reason: string }; resultText: string }> => {
            await launched.flush().catch(() => {});
            const produced = launched.view.getState().messages.slice(historyBefore);
            const summary = latestAssistantText(produced);
            const usage: TokenUsage | undefined = sumUsage(produced);
            if (outcome.type === 'done') {
              deps.rateLimit.reportSuccess();
              deps.fire({ type: 'tower.completed', agentId, name: args.name, summary, usage });
              return {
                resultText: [
                  `agent_id: ${agentId}`,
                  `name: ${args.name}`,
                  'status: completed',
                  '',
                  '[summary]',
                  summary,
                ].join('\n'),
              };
            }
            const failure = classifyOutcome(outcome);
            if (outcome.type === 'failed' && isRateLimitError(outcome.error)) {
              deps.rateLimit.reportRateLimited();
            }
            if (outcome.type === 'aborted') {
              deps.fire({ type: 'tower.cancelled', agentId, name: args.name });
              return {
                died: { status: 'killed', reason: failure.message },
                resultText: [
                  `agent_id: ${agentId}`,
                  `name: ${args.name}`,
                  'status: killed',
                  '',
                  `subagent error: ${failure.message}`,
                ].join('\n'),
              };
            }
            deps.fire({ type: 'tower.failed', agentId, name: args.name, error: failure.message });
            return {
              died: { status: 'failed', reason: failure.message },
              resultText: [
                `agent_id: ${agentId}`,
                `name: ${args.name}`,
                'status: failed',
                '',
                `subagent error: ${failure.message}`,
              ].join('\n'),
            };
          };
          await store.registerAgent({
            name: args.name,
            agentId,
            sessionId: deps.sessionId,
            kind: args.kind,
            missionId: mission?.id,
            reviewTarget,
            reviewMissionId:
              reviewTarget !== undefined
                ? resolveMissionByBranch(state, reviewTarget)?.id
                : undefined,
            worktree: mission?.worktree,
            branch: mission?.branch,
            spawnedAt: new Date().toISOString(),
          });
          if (mission !== undefined) {
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
              agent: agentId,
              mission: mission?.id,
              target: reviewTarget,
              model: model.kind === 'explicit' ? model.name : undefined,
            },
            mission !== undefined
              ? join(MISSIONS_DIR, missionFileName(mission.id, mission.slug))
              : undefined,
          );

          const ack = [
            `name: ${args.name}`,
            `kind: ${args.kind}`,
            `agent_id: ${agentId}`,
            `task_id: ${toolCall.id}`,
            'status: running',
            ...(model.kind === 'explicit' ? [`model: ${model.name}`] : []),
            ...(mission !== undefined
              ? [
                  `mission: ${mission.id} — ${mission.title}`,
                  `branch: ${mission.branch}`,
                  `worktree: ${store.abs(join(WORKTREES_DIR, mission.worktree))}`,
                ]
              : [`review_target: ${reviewTarget ?? ''}`]),
            ...notes,
            '',
            `The ${args.kind} runs detached in the background; its completion arrives as a notification. Track progress with TowerStatus / TowerInbox; recover a dead agent with Agent(resume="${agentId}", run_in_background=true, prompt="...") — never foreground: its output flows back through the tower protocol files.`,
          ].join('\n');
          const settled = launched.loop
            .runTurn(
              createUserEntry(createUserMessage(prompt), {
                origin: { kind: 'subagent' },
              }),
              { signal },
            )
            .then(
              (outcome) => finish(outcome),
              async (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                deps.fire({ type: 'tower.failed', agentId, name: args.name, error: message });
                return {
                  died: { status: 'failed', reason: message },
                  resultText: [
                    `agent_id: ${agentId}`,
                    `name: ${args.name}`,
                    'status: failed',
                    '',
                    `subagent error: ${message}`,
                  ].join('\n'),
                };
              },
            )
            .then(async ({ died, resultText }) => {
              if (died !== undefined) {
                await store
                  .markAgentDied(agentId, died.status, died.reason)
                  .then(
                    () => undefined,
                    () => undefined,
                  );
              }
              return text(resultText);
            });
          void settled
            .catch(() => {})
            .finally(() => {
              deps.rateLimit.release();
              const record = deps.registry.get(agentId);
              if (record !== undefined) record.running = false;
              deps.running.delete(agentId);
            });
          slotHeld = false;
          detach?.(ack);
          return await settled;
        } finally {
          if (slotHeld) deps.rateLimit.release();
        }
      } catch (error) {
        if (error instanceof TowerProtocolError || error instanceof GitError) {
          return errorText(error.message);
        }
        throw error;
      }
    },
  };
}

function latestAssistantText(messages: readonly HistoryMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i]!;
    if (entry.message.role !== 'assistant') continue;
    return extractText(entry.message);
  }
  return '';
}

function sumUsage(messages: readonly HistoryMessage[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const entry of messages) {
    if (entry.message.role !== 'assistant') continue;
    const usage = (entry.meta as AssistantMeta | undefined)?.usage;
    if (usage === undefined) continue;
    total = total === undefined ? usage : addUsage(total, usage);
  }
  return total;
}

function classifyOutcome(outcome: TurnOutcome): { readonly message: string } {
  if (outcome.type === 'aborted') {
    return { message: stoppedMessage(outcome.reason) };
  }
  if (outcome.type === 'blocked') {
    return { message: outcome.cause.message ?? outcome.cause.reason };
  }
  if (outcome.type === 'failed') {
    const error = outcome.error;
    return {
      message:
        error instanceof Error
          ? error.message
          : error === undefined
            ? 'Agent turn failed'
            : String(error),
    };
  }
  return { message: 'Subagent turn ended without a final message.' };
}

function stoppedMessage(reason: unknown): string {
  const text =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return text.length === 0 ? SUBAGENT_STOPPED_MESSAGE : `${SUBAGENT_STOPPED_MESSAGE} Reason: ${text}`;
}

function isRateLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { readonly kind?: unknown }).kind === 'rate_limit';
}
