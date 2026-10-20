import type { AnyMessage, PromptResponse, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';

export interface AcpStreamPair {
  readonly readable: ReadableStream<AnyMessage>;
  readonly writable: WritableStream<AnyMessage>;
}

export type AcpStopReason = PromptResponse['stopReason'];

export type AcpToolCallStatus = ToolCallStatus;

export type AcpToolKind = ToolKind;
