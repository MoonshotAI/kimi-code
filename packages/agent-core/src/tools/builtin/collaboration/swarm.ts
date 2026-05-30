/**
 * SwarmTool — collaboration tool that runs a task as a self-directed agent
 * swarm.
 *
 * Like {@link AgentTool}, this is a "collaboration tool": it uses
 * `SessionSubagentHost` (injected via the constructor) to create in-process
 * subagents. The {@link SwarmCoordinator} dynamically decomposes the task into
 * parallel role-specialized workers, then synthesizes their outputs into one
 * answer.
 *
 * Workers are spawned with an ad-hoc `profileOverride`, and the tool is
 * registered only on non-sub agents so a swarm worker can never launch another
 * swarm (recursion guard).
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { Logger } from '../../../logging';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import { SwarmCoordinator } from '../../../agent/swarm/coordinator';
import { DEFAULT_STALL_REPEAT_THRESHOLD } from '../../../agent/swarm/types';
import { createStallDetectionHook } from '../../../agent/swarm/stall-hook';
import { linkAbortSignal } from '../../../utils/abort';

export const SwarmToolInputSchema = z.object({
  task: z.string().describe('The high-level task to decompose and run as a parallel agent swarm.'),
});

export type SwarmToolInput = z.infer<typeof SwarmToolInputSchema>;

const SWARM_DESCRIPTION =
  'Run a task as a self-directed agent swarm: dynamically decompose it into parallel ' +
  'role-specialized subagents, then synthesize their outputs into one answer. ' +
  'Use for broad, parallelizable tasks (research, multi-file analysis). ' +
  'Subagents run in isolated contexts and cannot themselves launch swarms.';

const DEFAULT_MAX_CONCURRENCY = 4;

export class SwarmTool implements BuiltinTool<SwarmToolInput> {
  readonly name: string = 'Swarm';
  readonly description: string = SWARM_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SwarmToolInputSchema);
  private readonly log: Logger | undefined;

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    options?: { log?: Logger },
  ) {
    this.log = options?.log;
  }

  resolveExecution(args: SwarmToolInput): ToolExecution {
    return {
      description: `Running swarm: ${args.task.replace(/\s+/g, ' ').trim().slice(0, 60)}`,
      approvalRule: 'Swarm',
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: SwarmToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const stallRepeatThreshold = DEFAULT_STALL_REPEAT_THRESHOLD;
    const coordinator = new SwarmCoordinator({
      signal: ctx.signal,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      onProgress: (text) => ctx.onUpdate?.({ kind: 'status', text }),
      onProgressCustom: (progress) =>
        ctx.onUpdate?.({ kind: 'custom', customKind: 'swarm', customData: progress }),
      spawnSubagent: async ({ profileName, systemPrompt, tools, prompt, description, signal }) => {
        // Workers (the swarm:<role> spawns) get stall detection. Planner and
        // synthesizer make no tool calls, so the hook is harmless there but we
        // scope it to workers to keep their behavior identical.
        const isWorker = profileName.startsWith('swarm:');
        if (!isWorker) {
          const handle = await this.subagentHost.spawn(profileName, {
            parentToolCallId: ctx.toolCallId,
            prompt,
            description,
            runInBackground: false,
            signal,
            profileOverride: { systemPrompt, tools },
          });
          return handle.completion;
        }

        // Per-worker AbortController linked to the incoming signal: a
        // coordinator cancel still propagates DOWN, but a stall aborts ONLY
        // this worker — the coordinator's signal stays unaborted, so the wave
        // records a single failed subtask instead of cancelling the swarm.
        const workerController = new AbortController();
        const unlink = linkAbortSignal(signal, workerController);
        let stallReason: string | undefined;
        const loopHooks = createStallDetectionHook({
          repeatThreshold: stallRepeatThreshold,
          onStall: (reason) => {
            stallReason = reason;
            this.log?.warn(`swarm worker stalled (${description}): ${reason}`);
            workerController.abort(new Error(reason));
          },
        });
        try {
          const handle = await this.subagentHost.spawn(profileName, {
            parentToolCallId: ctx.toolCallId,
            prompt,
            description,
            runInBackground: false,
            signal: workerController.signal,
            profileOverride: { systemPrompt, tools },
            loopHooks,
          });
          return await handle.completion;
        } catch (error) {
          // A stall aborts the worker, which surfaces as a generic cancellation
          // ("Subagent turn cancelled"). Re-throw the distinguishable stalled
          // reason instead so the coordinator records it on the subtask — but
          // only when the incoming (coordinator) signal is NOT itself aborted,
          // so a genuine swarm-wide cancel still propagates as a cancel.
          if (stallReason !== undefined && !signal.aborted) {
            throw new Error(stallReason, { cause: error });
          }
          throw error;
        } finally {
          unlink();
        }
      },
    });

    try {
      const output = await coordinator.run(args.task);
      return { output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.error(`swarm failed: ${message}`);
      // Distinguish an ordinary failure (planner/synthesizer error) from a
      // genuine cancel (the turn was aborted). For a real failure, drive the
      // dashboard to a 'failed' state that surfaces the reason; an abort emits
      // nothing here so the card still finalizes as 'cancelled' on the error
      // result. Without this, ordinary failures masquerade as a success-toned
      // 'cancelled' card with the reason hidden.
      if (!ctx.signal.aborted) {
        ctx.onUpdate?.({
          kind: 'custom',
          customKind: 'swarm',
          customData: { phase: 'failed', message },
        });
      }
      return { output: `Swarm failed: ${message}`, isError: true };
    }
  }
}
