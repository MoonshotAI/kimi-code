/**
 * `agentUsageService` + `agentRPCService` — the agent-scope usage snapshot and
 * the raw per-agent RPC surface. Both engine-backed: usage reads the engine's
 * cumulative token snapshot (`sessionGetUsage`); the RPC methods pass through
 * to the engine's session/permission RPCs.
 *
 * The engine's usage triples (`input_tokens`/`output_tokens`/`total_tokens`)
 * map onto the contract `TokenUsage` (`inputOther`/`output`/
 * `inputCacheRead`/`inputCacheCreation`) — the engine does not track the cache
 * breakdown, so those fields are 0 (the migration's faithful stand-in, like
 * `archived: false` in sessionIndex).
 *
 * The klient's prompt/steer launch-result contract (`{ turn_id }`) has no
 * engine counterpart: `session/prompt` runs the whole turn synchronously and
 * returns the final result, and turn outcomes flow through the events hub —
 * so the RPC methods resolve to `undefined` (the `maybe` contract's no-result
 * arm). Callers that need turn results watch the agent `events` hub.
 */

import { RPCError } from '../../../core/errors.js';
import { registerService } from '../router.js';
import type { RustCallContext, RustServiceRegistry } from '../types.js';

/** Engine-side usage token triple (serde snake_case). */
interface EngineTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** Engine-side cumulative usage snapshot (rust-loop `EngineSessionUsage`). */
interface EngineUsageLike {
  by_model?: Record<string, EngineTokenUsage>;
  total?: EngineTokenUsage;
  current_turn?: EngineTokenUsage;
}

/** Contract `TokenUsage` — the four required numeric fields. */
interface ContractTokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

/** Contract `UsageStatus` — all fields optional, `{}` for a usage-less session. */
interface ContractUsageStatus {
  byModel?: Record<string, ContractTokenUsage>;
  total?: ContractTokenUsage;
  currentTurn?: ContractTokenUsage;
}

/** Contract `PromptPayload` (subset of `ContentPart` on the wire). */
interface PromptPayloadLike {
  input?: unknown[];
  disabledTools?: string[];
}

/** Contract `SteerPayload`. */
interface SteerPayloadLike {
  input?: unknown[];
}

/** Contract `SetPermissionPayload`. */
interface SetPermissionPayloadLike {
  mode?: 'manual' | 'yolo' | 'auto';
}

export function toTokenUsage(usage: EngineTokenUsage): ContractTokenUsage {
  return {
    inputOther: usage.input_tokens,
    output: usage.output_tokens,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
}

/** Map the engine's snake_case snapshot onto the contract `UsageStatus`. */
export function toUsageStatus(
  usage: EngineUsageLike | null | undefined,
): ContractUsageStatus {
  if (usage === null || usage === undefined) return {};
  const status: ContractUsageStatus = {};
  if (usage.by_model !== undefined) {
    const byModel: Record<string, ContractTokenUsage> = {};
    for (const [model, tokens] of Object.entries(usage.by_model)) {
      byModel[model] = toTokenUsage(tokens);
    }
    status.byModel = byModel;
  }
  if (usage.total !== undefined) status.total = toTokenUsage(usage.total);
  if (usage.current_turn !== undefined) status.currentTurn = toTokenUsage(usage.current_turn);
  return status;
}

/** The engine's per-session RPCs all key on the scope session id. */
function requireSessionId(ctx: RustCallContext): string {
  const sessionId = ctx.scope.sessionId;
  if (sessionId === undefined || sessionId === '') {
    throw new RPCError(40001, 'requires a session scope');
  }
  return sessionId;
}

export const agentUsageService: RustServiceRegistry = {
  /** Cumulative usage snapshot; `{}` when the session has no usage yet. */
  async status(ctx) {
    const usage = await ctx.rust.sessionGetUsage(requireSessionId(ctx));
    return toUsageStatus(usage);
  },
};

export const agentRPCService: RustServiceRegistry = {
  /**
   * Run a prompt turn synchronously in the engine. `disabledTools` has no
   * engine RPC equivalent and is not forwarded; `agentId` (side-question
   * routing) is. Resolves `undefined` — see the module header.
   */
  async prompt(ctx) {
    const sessionId = requireSessionId(ctx);
    const payload = (ctx.args[0] ?? {}) as PromptPayloadLike;
    await ctx.rust.sessionPrompt(
      sessionId,
      payload.input as unknown as Parameters<typeof ctx.rust.sessionPrompt>[1],
      ctx.scope.agentId,
    );
    return undefined;
  },

  /** Queue steer input for the session; drained at the next turn start. */
  async steer(ctx) {
    const sessionId = requireSessionId(ctx);
    const payload = (ctx.args[0] ?? {}) as SteerPayloadLike;
    await ctx.rust.sessionSteer(
      sessionId,
      payload.input as unknown as Parameters<typeof ctx.rust.sessionSteer>[1],
    );
    return undefined;
  },

  /** Cancel the session's running turn. The contract `turnId` has no engine
   *  equivalent — `session/cancel` stops the current turn at the next step
   *  boundary. */
  async cancel(ctx) {
    await ctx.rust.sessionCancel(requireSessionId(ctx));
    return undefined;
  },

  /** Set the permission mode. The engine's `permission/set_mode` is global
   *  (no session id), while the klient surface is per-agent — accepted as-is. */
  async setPermission(ctx) {
    const payload = (ctx.args[0] ?? {}) as SetPermissionPayloadLike;
    await ctx.rust.permissionSetMode(
      payload.mode as unknown as Parameters<typeof ctx.rust.permissionSetMode>[0],
    );
    return undefined;
  },

  /** Full context snapshot; engine `token_count` maps to `tokenCount`. */
  async getContext(ctx) {
    const context = await ctx.rust.sessionGetContext(requireSessionId(ctx));
    if (context === null || context === undefined) return { history: [], tokenCount: 0 };
    return { history: context.history, tokenCount: context.token_count };
  },
};

registerService('agentUsageService', agentUsageService);
registerService('agentRPCService', agentRPCService);
