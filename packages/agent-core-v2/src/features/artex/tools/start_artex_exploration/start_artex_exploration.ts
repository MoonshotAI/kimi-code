import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IFlagService } from '#/app/flag/flag';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { ARTEX_FLAG_ID } from '#/features/artex/artex';
import { IArtexModeService } from '#/features/artex/agent/artexMode';
import { IArtexOrchestrator } from '#/features/artex/engine/artexOrchestrator';
import { newArtexBudget } from '#/features/artex/logic/budget';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { artexRootDir } from '#/features/artex/store/paths';

import { artexErr, artexJson } from '../toolSupport';
import DESCRIPTION from './start_artex_exploration.md?raw';

export const StartArtexExplorationInputSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'status']).optional(),
  goal: z.string().optional(),
  description: z.string().optional(),
  exploration_id: z.number().int().min(1).optional(),
  background: z.boolean().optional(),
  target_concurrency: z.number().int().min(1).max(128).optional(),
  timeout_seconds: z.number().int().min(0).optional(),
  max_waves: z.number().int().min(1).optional(),
  token_budget: z.number().int().min(0).optional(),
  turn_budget: z.number().int().min(0).optional(),
});

export type StartArtexExplorationInput = z.infer<typeof StartArtexExplorationInputSchema>;

const PARAMETERS = toInputJsonSchema(StartArtexExplorationInputSchema);

export const IArtexStartExplorationTool: ServiceIdentifier<AgentTool<StartArtexExplorationInput>> =
  createDecorator<AgentTool<StartArtexExplorationInput>>('artexStartExplorationTool');

async function nextExplorationId(workspaceRoot: string): Promise<number> {
  const dir = join(artexRootDir(workspaceRoot), 'explorations');
  try {
    const entries = await readdir(dir);
    let maxId = 0;
    for (const entry of entries) {
      const parsed = Number(entry);
      if (Number.isInteger(parsed) && parsed > maxId) maxId = parsed;
    }
    return maxId + 1;
  } catch {
    return 1;
  }
}

export class ArtexStartExplorationTool implements AgentTool<StartArtexExplorationInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'start_artex_exploration' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexOrchestrator private readonly orchestrator: IArtexOrchestrator,
    @IArtexModeService private readonly mode: IArtexModeService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IFlagService private readonly flags: IFlagService,
  ) {}

  resolveExecution(args: StartArtexExplorationInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Running ARTEX exploration (${args.action ?? 'start'})`,
      execute: (ctx) => this.execute(args, ctx.signal),
    };
  }

  private async execute(
    args: StartArtexExplorationInput,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    if (!this.flags.enabled(ARTEX_FLAG_ID)) {
      return artexErr('ARTEX experiment is disabled; enable KIMI_CODE_EXPERIMENTAL_ARTEX=1');
    }
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) {
      return artexErr('start_artex_exploration is only available to the main agent');
    }

    const action = args.action ?? 'start';
    const root = this.session.workspaceRoot;

    if (action === 'status') {
      const explorationId = args.exploration_id ?? this.session.getActiveExplorationId();
      if (explorationId === undefined) {
        return artexErr('no active ARTEX exploration');
      }
      const status = this.orchestrator.getStatus(explorationId);
      const store = this.provider.open(root, explorationId);
      const initialized = await store.isInitialized();
      const stats = initialized ? await store.stats() : undefined;
      return {
        output: artexJson({
          exploration_id: explorationId,
          initialized,
          status: status ?? { running: false },
          node_counts: stats,
        }),
      };
    }

    if (action === 'pause') {
      const explorationId = args.exploration_id ?? this.session.getActiveExplorationId();
      if (explorationId === undefined) {
        return artexErr('no active ARTEX exploration to pause');
      }
      const paused = await this.orchestrator.pause(explorationId);
      return {
        output: artexJson({
          exploration_id: explorationId,
          paused,
          status: this.orchestrator.getStatus(explorationId) ?? { running: false },
        }),
      };
    }

    if (action === 'resume') {
      const explorationId = args.exploration_id ?? this.session.getActiveExplorationId();
      if (explorationId === undefined) {
        return artexErr('no active ARTEX exploration to resume');
      }
      const store = this.provider.open(root, explorationId);
      if (!(await store.isInitialized())) {
        return artexErr(`exploration ${String(explorationId)} is not initialized`);
      }
      this.session.setActiveExplorationId(explorationId);
      this.mode.enter(explorationId);
      return this.launchRun(explorationId, args, signal);
    }

    const explorationId = args.exploration_id ?? (await nextExplorationId(root));
    const store = this.provider.open(root, explorationId);
    if (!(await store.isInitialized())) {
      const goal = (args.goal ?? args.description ?? '').trim();
      if (goal.length === 0) {
        return artexErr('goal is required to start a new ARTEX exploration');
      }
      await store.init((args.description ?? '').trim(), goal);
    }
    this.session.setActiveExplorationId(explorationId);
    this.mode.enter(explorationId);
    return this.launchRun(explorationId, args, signal);
  }

  private async launchRun(
    explorationId: number,
    args: StartArtexExplorationInput,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    const taskBudget =
      args.token_budget !== undefined || args.turn_budget !== undefined
        ? newArtexBudget(args.token_budget ?? 0, args.turn_budget ?? 0)
        : undefined;
    const runOptions = {
      explorationId,
      callerAgentId: this.scopeContext.agentId,
      workspaceRoot: this.session.workspaceRoot,
      targetConcurrency: args.target_concurrency,
      timeoutSeconds: args.timeout_seconds,
      maxWaves: args.max_waves,
      taskBudget,
    };

    if (args.background === false) {
      const summary = await this.orchestrator.run({ ...runOptions, signal });
      return {
        output: artexJson({
          exploration_id: explorationId,
          status: 'completed',
          ...summary,
        }),
      };
    }

    this.orchestrator.start(runOptions);
    return {
      output: artexJson({
        exploration_id: explorationId,
        status: 'running',
        orchestrator: this.orchestrator.getStatus(explorationId),
      }),
    };
  }
}
