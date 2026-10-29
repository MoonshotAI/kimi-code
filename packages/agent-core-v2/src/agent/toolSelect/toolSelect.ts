import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ToolDescription as Tool } from '#human/llm/message';
import type { ToolInfo } from '#/tool/toolContract';

export const SELECT_TOOLS_TOOL_NAME = 'select_tools';

export interface ToolSelectCapabilities {
  readonly dynamically_loaded_tools?: boolean;
  readonly tool_use?: boolean;
}

export interface ShapedToolEntry extends ToolInfo {
  readonly deferred?: true;
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

  defaultTools(disclosure?: boolean): readonly Tool[];

  shapeTools(entries: readonly ToolInfo[], disclosure?: boolean): readonly ShapedToolEntry[];

  shapeHistory(
    messages: readonly ContextMessage[],
    disclosure?: boolean,
  ): readonly ContextMessage[];

  load(names: readonly string[]): LoadToolsResult;

  loadableToolsAnnouncement(): string | undefined;
}

export const IAgentToolSelectService: ServiceIdentifier<IAgentToolSelectService> =
  createDecorator<IAgentToolSelectService>('agentToolSelectService');
