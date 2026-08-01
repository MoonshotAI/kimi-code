/**
 * Rust agent engine bridge for the v2 (agent-core-v2) path.
 *
 * Mirrors the v1 wiring in `../rust-engine.ts`: the Rust engine is the only
 * opts out (the engine defaults to Rust), the battle-tested v1 adapter
 * (`createRunTurnOverride` from
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
 * Wired through the process-wide `registerLoopTurnOverrideFactory` seam: one
 * `registerRustEngineV2()` call at app startup covers every v2 agent created
 * afterwards — the main agent, subagents, and kap-server/web sessions — each
 * of which resolves its own override lazily with its own agent-scope services.
 * Turns then run in the Rust engine end to end while every side effect stays
 * in the v2 service graph.
 */

import type { LoopTurnOverride, ServicesAccessor } from '@moonshot-ai/agent-core-v2';
import {
  IAgentContextMemoryService,
  IAgentLLMRequesterService,
  IAgentToolExecutorService,
  IAgentToolRegistryService,
  IConfigService,
  IEventBus,
  registerLoopTurnOverrideFactory,
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
  options: { nativeTools: boolean; nativeLlm?: unknown },
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
 * Build this agent's turn override from its own agent-scope service graph.
 *
 * This is the `LoopTurnOverrideFactory` handed to agent-core-v2. The accessor
 * dies as soon as the synchronous part of this call returns, so the config
 * check and every service lookup happen before the first `await`; only the
 * adapter import and override construction run asynchronously.
 *
 * Throws when the Rust engine cannot be used — the deprecated JS loop is no
 * longer a fallback (the v1/v2 migration is complete).
 */
function buildRustTurnOverride(
  accessor: ServicesAccessor,
): Promise<LoopTurnOverride> | undefined {
  const config = accessor.get(IConfigService);
  const agentConfig = config.get<{ engine?: string; nativeTools?: boolean } | undefined>('agent');
  // Same default as the v1 path (rust-engine.ts): the engine defaults to
  // Rust even when the `[agent]` section is absent.
  if ((agentConfig?.engine ?? 'rust') !== 'rust') {
    throw new Error(
      '[kimi-agent] agent.engine must be "rust" — the JS engine was removed with the ' +
        'v1/v2 migration.',
    );
  }

  const llmRequester = accessor.get(IAgentLLMRequesterService);
  const context = accessor.get(IAgentContextMemoryService);
  const toolRegistry = accessor.get(IAgentToolRegistryService);
  const toolExecutor = accessor.get(IAgentToolExecutorService);
  const eventBus = accessor.get(IEventBus);
  // The accessor must not be touched past this point.

  return (async (): Promise<LoopTurnOverride> => {
    let createRunTurnOverride: CreateRunTurnOverride;
    try {
      const mod = (await import('@moonshot-ai/kimi-agent/rust-loop')) as {
        createRunTurnOverride: CreateRunTurnOverride;
      };
      createRunTurnOverride = mod.createRunTurnOverride;
    } catch (error) {
      throw new Error(
        `[kimi-agent] Rust engine adapter failed to load: ${String(error)}`, { cause: error },
      );
    }

    // Native-LLM transport: when a static provider is configured, the Rust
    // engine talks to the provider directly and the v2 llmRequester steps out
    // of the hot path (its system-prompt/profile/usage duties move to the
    // engine). Falls back to the host proxy otherwise.
    let nativeLlm: unknown;
    try {
      const { loadNativeLlmDef } = await import('../rust-engine');
      nativeLlm = loadNativeLlmDef();
    } catch {
      nativeLlm = undefined;
    }

    const override = createRunTurnOverride(undefined, process.cwd(), {
      nativeTools: agentConfig?.nativeTools !== false,
      nativeLlm,
    });
    if (override === undefined) {
      throw new Error(
        '[kimi-agent] Rust engine unavailable (no napi addon or binary found). ' +
          'Reinstall or rebuild the kimi-agent package.',
      );
    }

    return async ({ turnId, signal }) => {
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
          } else if (type === 'text.delta') {
            // Native-LLM mode: the v2 requester never runs, so its
            // `assistant.delta` stream is missing — replay the engine's delta
            // channel onto the turn-event bus (print mode / TUI / web render
            // from it).
            eventBus.publish({
              type: 'assistant.delta',
              turnId,
              delta: event['delta'],
            } as never);
          } else if (type === 'thinking.delta') {
            eventBus.publish({
              type: 'thinking.delta',
              turnId,
              delta: event['delta'],
            } as never);
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
              parameters: info.parameters ?? {},
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
    };
  })();
}

/**
 * Register the Rust engine's turn-override factory process-wide.
 *
 * Call once at app startup, before agents are created. Idempotent: the
 * registry holds a single factory, so repeated calls just re-register the
 * same function.
 */
export function registerRustEngineV2(): void {
  registerLoopTurnOverrideFactory(buildRustTurnOverride);
}
