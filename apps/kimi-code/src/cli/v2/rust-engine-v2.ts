/**
 * Rust agent engine bridge for the v2 (agent-core-v2) path.
 *
 * Mirrors the v1 wiring in `../rust-engine.ts`: when `agent.engine = "rust"`,
 * the battle-tested v1 adapter (`createRunTurnOverride` from
 * `@moonshot-ai/kimi-agent/rust-loop`) drives the turn, and this module
 * adapts the v2 DI services to the v1 `RunTurnInput` contract it consumes:
 *
 *   - `llm.chat`        → `IAgentLLMRequesterService.request()` (which owns the
 *                         system prompt, profile, recovery projections, and
 *                         usage recording)
 *   - `buildMessages`   → `IAgentContextMemoryService.get()`
 *   - `dispatchEvent`   → `IAgentContextMemoryService.appendLoopEvent()` for
 *                         recorded events (v2's transcript/UI project from the
 *                         wire records, so no separate delta channel is needed)
 *   - tools             → `IAgentToolRegistryService` definitions executed
 *                         through `IAgentToolExecutorService.execute()`, so
 *                         approval, policy, dedupe, and hooks all still apply.
 *
 * Installed per-agent through the `IAgentLoopService.setTurnOverride` seam;
 * turns then run in the Rust engine end to end while every side effect stays
 * in the v2 service graph.
 */

import type { ServicesAccessor } from '@moonshot-ai/agent-core-v2';
import {
  IAgentContextMemoryService,
  IAgentLLMRequesterService,
  IAgentLoopService,
  IAgentToolExecutorService,
  IAgentToolRegistryService,
  IConfigService,
  IEventBus,
} from '@moonshot-ai/agent-core-v2';

interface V1ChatParams {
  readonly messages: unknown[];
  readonly tools: readonly unknown[];
  readonly signal: AbortSignal;
  readonly onTextPart?: (part: { type: 'text'; text: string }) => Promise<void> | void;
  readonly onThinkPart?: (part: { type: 'think'; think: string }) => Promise<void> | void;
  readonly onTextDelta?: (delta: string) => void;
  readonly onThinkDelta?: (delta: string) => void;
}

interface V1ChatResponse {
  readonly toolCalls: unknown[];
  readonly providerFinishReason?: unknown;
  readonly usage: unknown;
}

interface V1ExecutableTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  resolveExecution(input: unknown):
    | {
        execute: (ctx: { toolCallId: string; signal: AbortSignal }) => Promise<{
          output: unknown;
          isError?: boolean;
          note?: string;
        }>;
      }
    | { output: string; isError: true };
}

interface V1RunTurnInput {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly llm: {
    readonly systemPrompt: string;
    readonly modelName: string;
    chat(params: V1ChatParams): Promise<V1ChatResponse>;
  };
  readonly buildMessages: () => unknown[];
  readonly dispatchEvent: (event: Record<string, unknown>) => Promise<void>;
  readonly buildTools: () => readonly V1ExecutableTool[];
}

/** v1 `TurnResult`: a stop reason, not v2's discriminated union. */
interface V1TurnResult {
  readonly stopReason: 'end_turn' | 'max_tokens' | 'filtered' | 'paused' | 'unknown' | 'aborted';
  readonly steps: number;
}

type CreateRunTurnOverride = (
  providers: undefined,
  workspaceRoot: string | undefined,
  options: { nativeTools: boolean },
) => ((input: V1RunTurnInput) => Promise<V1TurnResult>) | undefined;

/** Map the v1 result onto v2's `LoopRunResult` union. */
function toLoopRunResult(
  result: V1TurnResult,
):
  | { type: 'completed'; steps: number; truncated: boolean }
  | { type: 'cancelled'; steps: number; reason: unknown } {
  if (result.stopReason === 'aborted') {
    return { type: 'cancelled', steps: result.steps, reason: 'aborted' };
  }
  // `max_tokens` is v2's "truncated" completion; the remaining terminal
  // reasons (`end_turn` / `filtered` / `paused` / `unknown`) all end the turn
  // without an error, matching the v1 harness's treatment.
  return {
    type: 'completed',
    steps: result.steps,
    truncated: result.stopReason === 'max_tokens',
  };
}

/** Loop-event types that persist as `context.append_loop_event` records. */
const RECORDED_EVENT_TYPES = new Set([
  'step.begin',
  'step.end',
  'content.part',
  'tool.call',
  'tool.result',
]);

/**
 * Install the Rust engine as this agent's turn runner, when configured.
 *
 * Returns `true` when installed; `false` leaves the JS loop in charge
 * (engine not "rust", adapter unavailable, or the addon failed to load).
 */
export async function installRustEngineV2(accessor: ServicesAccessor): Promise<boolean> {
  const config = accessor.get(IConfigService);
  const agentConfig = config.get<{ engine?: string; nativeTools?: boolean } | undefined>('agent');
  if (agentConfig?.engine !== 'rust') return false;

  let createRunTurnOverride: CreateRunTurnOverride;
  try {
    const mod = (await import('@moonshot-ai/kimi-agent/rust-loop')) as {
      createRunTurnOverride: CreateRunTurnOverride;
    };
    createRunTurnOverride = mod.createRunTurnOverride;
  } catch {
    return false;
  }

  const override = createRunTurnOverride(undefined, process.cwd(), {
    nativeTools: agentConfig.nativeTools !== false,
  });
  if (override === undefined) return false;

  const loop = accessor.get(IAgentLoopService);
  const llmRequester = accessor.get(IAgentLLMRequesterService);
  const context = accessor.get(IAgentContextMemoryService);
  const toolRegistry = accessor.get(IAgentToolRegistryService);
  const toolExecutor = accessor.get(IAgentToolExecutorService);
  const eventBus = accessor.get(IEventBus);

  loop.setTurnOverride(async ({ turnId, signal }) => {
    const input: V1RunTurnInput = {
      turnId: String(turnId),
      signal,
      llm: {
        // The v2 requester owns the system prompt and model resolution; these
        // fields only label the wire for the host-proxy path.
        systemPrompt: '',
        modelName: 'v2',
        chat: async (params) => {
          const finish = await llmRequester.request(
            {
              messages: params.messages as never,
              tools: params.tools as never,
              source: 'loop' as never,
            },
            // Stream deltas onto the turn-event bus so print mode and the
            // TUI render live, exactly as the JS loop's part handler does.
            (part: { type: string; text?: string; think?: string }) => {
              if (part.type === 'text' && part.text !== undefined) {
                eventBus.publish({ type: 'assistant.delta', turnId, delta: part.text } as never);
              } else if (part.type === 'think' && part.think !== undefined) {
                eventBus.publish({ type: 'thinking.delta', turnId, delta: part.think } as never);
              }
            },
            params.signal,
          );
          // Feed completed blocks back so the Rust-driven transcript records
          // them; deltas already streamed to the UI via the requester's own
          // event channel.
          for (const part of finish.message.content) {
            if (part.type === 'text') {
              await params.onTextPart?.({ type: 'text', text: part.text });
            } else if (part.type === 'think') {
              await params.onThinkPart?.({ type: 'think', think: part.think });
            }
          }
          return {
            toolCalls: (finish.message.toolCalls ?? []) as unknown[],
            providerFinishReason: finish.providerFinishReason,
            usage: finish.usage,
          };
        },
      },
      buildMessages: () => context.get() as unknown as unknown[],
      dispatchEvent: (event) => {
        const type = event['type'];
        if (typeof type === 'string' && RECORDED_EVENT_TYPES.has(type)) {
          context.appendLoopEvent(event as never);
        }
        // Live-only events (text.delta / thinking.delta / …) are not needed:
        // v2 surfaces project from the wire records appended above.
        return Promise.resolve();
      },
      buildTools: () =>
        toolRegistry.list().map(
          (info): V1ExecutableTool => ({
            name: info.name,
            description: info.description,
            parameters: (info.parameters ?? {}),
            resolveExecution: (args: unknown) => ({
              execute: async (ctx) => {
                // Route through the full v2 executor pipeline so approval,
                // policy, dedupe, and hooks all apply exactly as in JS turns.
                const calls = [
                  {
                    type: 'function' as const,
                    id: ctx.toolCallId,
                    name: info.name,
                    arguments: JSON.stringify(args ?? {}),
                  },
                ];
                for await (const outcome of toolExecutor.execute(calls as never, {
                  signal: ctx.signal,
                  turnId,
                })) {
                  return {
                    output: outcome.result.output,
                    isError: outcome.result.isError === true,
                    note: (outcome.result as { note?: string }).note,
                  };
                }
                return { output: 'Tool produced no result', isError: true };
              },
            }),
          }),
        ),
    };
    return toLoopRunResult(await override(input));
  });
  return true;
}
