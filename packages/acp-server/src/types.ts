import type { PromptResponse, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';

export type AcpStopReason = PromptResponse['stopReason'];

export type AcpToolCallStatus = ToolCallStatus;

export type AcpToolKind = ToolKind;
