/**
 * Approval service interface + protocol adapter.
 *
 * **Service interface** (`IApprovalService`): Reverse-RPC one-shot broker
 * role — routes `ApprovalRequest`s coming out of `KimiCore` to a waiter
 * (web client over WS, mock handler in tests) and resolves the
 * promise when the response arrives.
 *
 * Role: one-shot broker — see `packages/services/AGENTS.md`. Kept under the
 * `Service` suffix per the package-wide convention; the broker semantics
 * lives in the interface shape (`request` + `resolve`) and the docstring,
 * not in the type name.
 *
 * **Shape note:** the service's `request()` returns the agent-core
 * in-process `ApprovalResponse` (`{ decision, scope?, feedback?,
 * selectedLabel? }`, see `packages/agent-core/src/rpc/sdk-api.ts:10`).
 * SCHEMAS.md §6.1 defines a protocol-level `ApprovalResponse` with the same
 * fields in snake_case (`selected_label`). The protocol↔in-process adapter
 * lives at the daemon/REST boundary (see SCHEMAS.md §6.4) — the service
 * stays SDK-shaped. When the protocol Zod validator ships,
 * this interface stays SDK-shaped; the REST handler adapts.
 *
 * **Adapter** (`toBrokerRequest` / `toAgentCoreResponse`): Bridges two
 * representations of the same approval interaction:
 *
 *   1. **In-process SDK shape** (agent-core, camelCase) — what `BridgeClientAPI`
 *      sees coming off `KimiCore.requestApproval(...)`. See
 *      `packages/agent-core/src/rpc/sdk-api.ts:17-23`:
 *        `ApprovalRequest { turnId?, toolCallId, toolName, action, display }`
 *      and `ApprovalResponse { decision, scope?, feedback?, selectedLabel? }`.
 *
 *   2. **Protocol wire shape** (snake_case, with daemon-allocated metadata) —
 *      what the daemon broadcasts as `event.approval.requested` and what the
 *      REST resolve handler receives as request body. See SCHEMAS.md §6.1 and
 *      `packages/protocol/src/approval.ts`.
 *
 * **Field translations**:
 *
 *     SDK (camelCase) → Protocol (snake_case)
 *     ----------------------------------------
 *     toolCallId      → tool_call_id
 *     toolName        → tool_name
 *     turnId          → turn_id          (optional)
 *     display         → tool_input_display  (passthrough — 12-arm union)
 *     selectedLabel   → selected_label   (response side)
 *
 * **Anti-corruption**: this is the ONLY place protocol↔SDK shape translation
 * happens for approval. Daemon routes call `toBrokerRequest` indirectly via
 * the adapter (KimiCore → BridgeClientAPI.requestApproval →
 * IApprovalService.request), and `toAgentCoreResponse` from the REST resolve
 * handler.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { ApprovalRequest, ApprovalResponse } from '@moonshot-ai/agent-core';
import type {
  ApprovalRequest as ProtocolApprovalRequest,
  ApprovalResponse as ProtocolApprovalResponse,
} from '@moonshot-ai/protocol';
import type {} from '@moonshot-ai/protocol'; // type-only marker — keep protocol dep referenced

// Re-export ApprovalResponse for service-side consumers so they don't have to
// also depend on agent-core directly.
export type { ApprovalRequest, ApprovalResponse };

export interface IApprovalService {
  readonly _serviceBrand: undefined;

  /**
   * Called by the adapter when KimiCore needs user approval. Resolves with the
   * user's decision (or a cancelled response if no client is connected /
   * timeout elapses — concrete-impl policy).
   */
  request(req: ApprovalRequest & { sessionId: string; agentId: string }): Promise<ApprovalResponse>;

  /**
   * Called by the answer-side (REST handler / TUI / mock) to settle a pending
   * `request()` promise. `id` matches `ApprovalRequest.toolCallId`, the stable
   * correlation key.
   */
  resolve(id: string, response: ApprovalResponse): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IApprovalService = createDecorator<IApprovalService>('approvalService');

// ---------------------------------------------------------------------------
// Adapter helpers (moved from adapter/approval-adapter.ts)
// ---------------------------------------------------------------------------

export interface ToBrokerRequestParams {
  /** Daemon-minted ULID identifying this approval interaction. */
  readonly approvalId: string;
  /** Session the approval lives in. */
  readonly sessionId: string;
  /** `createdAt` ISO string; broker passes a fresh `new Date().toISOString()`. */
  readonly createdAt: string;
  /** `expiresAt` ISO string; broker computes `createdAt + 60s`. */
  readonly expiresAt: string;
}

/**
 * In-process SDK request + daemon-allocated metadata → protocol wire shape.
 *
 * Used by the daemon broker to build the WS `event.approval.requested`
 * payload before broadcasting.
 *
 * `req` may carry extra context fields (`sessionId`, `agentId`) appended by
 * the bridge — we read `sessionId` from `params.sessionId` (the authoritative
 * daemon-side source) and ignore any duplicate on the request.
 */
export function toBrokerRequest(
  req: ApprovalRequest,
  params: ToBrokerRequestParams,
): ProtocolApprovalRequest {
  return {
    approval_id: params.approvalId,
    session_id: params.sessionId,
    turn_id: req.turnId,
    tool_call_id: req.toolCallId,
    tool_name: req.toolName,
    action: req.action,
    // Passthrough — SCHEMAS §6.1 mandates 12-arm union preservation with
    // `generic.summary` fall-back rendering on the client.
    tool_input_display: req.display,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

/**
 * Protocol REST request body → in-process SDK response.
 *
 * Used by the REST resolve handler to settle the agent-side Promise.
 */
export function toAgentCoreResponse(
  resp: ProtocolApprovalResponse,
): ApprovalResponse {
  return {
    decision: resp.decision,
    scope: resp.scope,
    feedback: resp.feedback,
    selectedLabel: resp.selected_label,
  };
}
