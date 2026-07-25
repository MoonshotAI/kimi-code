/**
 * Shared types for the tool-call module.
 *
 * Extracted from tool-call.ts to reduce the main file's size and give
 * group components (AgentGroup, ReadGroup) a single import point for
 * snapshot interfaces.
 */

import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

export type SubagentTextKind = 'thinking' | 'text';
export type SubagentPhase = 'queued' | 'spawning' | 'running' | 'done' | 'failed' | 'backgrounded';

export interface FinishedSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
}

export interface OngoingSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly streamingArguments?: string | undefined;
}

export interface SubToolActivity {
  readonly id: string;
  name: string;
  args: Record<string, unknown>;
  phase: 'ongoing' | 'done' | 'failed';
  output?: string;
  readonly orderSeq: number;
}

/**
 * Immutable subagent state snapshot. `AgentGroupComponent` reads one-time
 * views via `ToolCallComponent.getSubagentSnapshot()` and renders its own
 * branch lines; `onSnapshotChange` notifies it when state changes.
 */
export interface ToolCallSubagentSnapshot {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolCallDescription: string;
  readonly agentName: string | undefined;
  readonly phase: SubagentPhase | undefined;
  readonly toolCount: number;
  readonly elapsedSeconds: number | undefined;
  readonly tokens: number;
  readonly isError: boolean;
  readonly errorText: string | undefined;
  readonly latestActivity: string | undefined;
}

/**
 * Immutable Read tool state snapshot. `ReadGroupComponent` reads one-time
 * views via `ToolCallComponent.getReadSnapshot()` and sums lines for the group
 * header.
 */
export interface ToolCallReadSnapshot {
  readonly toolCallId: string;
  readonly filePath: string | undefined;
  readonly phase: 'pending' | 'done' | 'failed';
  readonly lines: number;
}

// ── Event payload types (SDK events routed by KimiTUI) ──

export interface SubagentSpawnedMeta {
  readonly agentId: string;
  readonly agentName?: string | undefined;
  readonly runInBackground: boolean;
}

export interface SubagentStartedMeta {
  readonly agentId: string;
  readonly agentName?: string | undefined;
  readonly runInBackground: boolean;
}

export interface SubagentCompletedPayload {
  readonly contextTokens?: number | undefined;
  readonly usage?: TokenUsage | undefined;
  readonly resultSummary: string;
}

export interface SubagentFailedPayload {
  readonly error: string;
}

export interface SubagentMetricsPayload {
  readonly contextTokens?: number | undefined;
  readonly usage?: TokenUsage | undefined;
}

export interface BackgroundTaskTerminalStatus {
  readonly status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  readonly options: { readonly errorText?: string | undefined };
}

// ── Render context ──

export interface RenderContext {
  readonly expanded: boolean;
  readonly workspaceDir: string | undefined;
}

export type { ToolCallBlockData, ToolResultBlockData };
