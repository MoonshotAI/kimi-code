import type { PromptResponse, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';

/**
 * Local alias for the ACP `stopReason` enum.
 *
 * Surfaced separately so internal helpers (e.g. `turnEndReasonToStopReason`)
 * don't have to repeat the literal union and the file is the single place
 * to look when the upstream SDK widens or renames a variant.
 */
export type AcpStopReason = PromptResponse['stopReason'];

/**
 * Local alias for the ACP `ToolCallStatus` enum.
 *
 * Same rationale as {@link AcpStopReason}: keep SDK-coupled enum
 * names confined to this file so the rest of the adapter only sees
 * project-local types.
 */
export type AcpToolCallStatus = ToolCallStatus;

/**
 * Local alias for the ACP `ToolKind` enum.
 *
 * The kind is heuristic-mapped from Kimi tool names by
 * `events-map.inferToolKind`; aliasing here keeps the consumer side
 * (UI integration / future tool registries) decoupled from the raw
 * SDK type name.
 */
export type AcpToolKind = ToolKind;
