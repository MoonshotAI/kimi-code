import type {
  PermissionData,
} from '#/agent/permissionPolicy';
import { createDecorator } from "#/_base/di";
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '#/agent/tool';
import type { Hooks } from '#/hooks';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

export interface PermissionGateOptions {
  readonly agentId?: string;
}

export interface PermissionApprovalRequestContext {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly toolInput: unknown;
  readonly display: ToolInputDisplay;
}

export type PermissionApprovalResultContext =
  | {
      readonly turnId: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly action: string;
      readonly decision: 'approved' | 'rejected' | 'cancelled';
      readonly scope?: 'session';
      readonly feedback?: string;
      readonly selectedLabel?: string;
    }
  | {
      readonly turnId: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly action: string;
      readonly decision: 'error';
      readonly error: string;
    };

export interface IAgentPermissionGate {
  readonly _serviceBrand: undefined;

  data(): PermissionData;
  authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined>;

  readonly hooks: Hooks<{
    onDidRequestApproval: PermissionApprovalRequestContext;
    onDidResolveApproval: PermissionApprovalResultContext;
  }>;
}

export const IAgentPermissionGate =
  createDecorator<IAgentPermissionGate>('agentPermissionGate');
