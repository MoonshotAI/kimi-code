import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ToolDescription as Tool } from '#human/llm/message';
import type { ToolInfo } from '#/tool/toolContract';

import type { ToolSelectTool } from './toolSelectOps';

export const SELECT_TOOLS_TOOL_NAME = 'select_tools';

export interface ToolSelectCapabilities {
  readonly dynamically_loaded_tools?: boolean;
  readonly tool_use?: boolean;
}

export interface ShapedToolEntry extends ToolInfo {
  readonly deferred?: true;
  readonly origin?: 'initial' | 'runtime';
}

export type ToolSelectAnnouncementDisclosure =
  | {
      readonly kind: 'snapshot';
      readonly revision: number;
      readonly tools: readonly ToolSelectTool[];
    }
  | {
      readonly kind: 'delta';
      readonly revision: number;
      readonly added: readonly ToolSelectTool[];
      readonly removed: readonly ToolSelectTool[];
    };

export interface ToolSelectAnnouncement {
  readonly content: string;
  readonly disclosure: ToolSelectAnnouncementDisclosure;
}

export interface LoadToolsResult {
  readonly toLoad: readonly string[];
  readonly alreadyAvailable: readonly string[];
  readonly alreadyCallable: readonly string[];
  readonly staleLoaded: readonly string[];
  readonly policyDenied: readonly string[];
  readonly unknown: readonly string[];
  readonly escalated: Readonly<Record<string, number>>;
  readonly consecutiveFailures: number;
  readonly suggestions: Readonly<Record<string, readonly string[]>>;
  readonly loadable: readonly string[];
  readonly schemas: readonly Tool[];
}

export interface IAgentToolSelectService {
  readonly _serviceBrand: undefined;

  featureEnabled(): boolean;

  enabled(capabilities?: ToolSelectCapabilities): boolean;

  prepareForRequest(signal?: AbortSignal): Promise<void>;

  defaultTools(disclosure?: boolean): readonly Tool[];

  shapeTools(entries: readonly ToolInfo[], disclosure?: boolean): readonly ShapedToolEntry[];

  shapeHistory(
    messages: readonly ContextMessage[],
    disclosure?: boolean,
  ): readonly ContextMessage[];

  load(names: readonly string[]): LoadToolsResult;

  loadableToolsAnnouncement(
    lastDisclosure?: ToolSelectAnnouncementDisclosure,
  ): ToolSelectAnnouncement | undefined;
}

export const IAgentToolSelectService: ServiceIdentifier<IAgentToolSelectService> =
  createDecorator<IAgentToolSelectService>('agentToolSelectService');
