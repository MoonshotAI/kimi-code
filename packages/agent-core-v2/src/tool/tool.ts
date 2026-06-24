/**
 * `tool` domain (L3) — tool-definition registry + per-agent tool service.
 */

import { createDecorator, type ServiceIdentifier, type ServicesAccessor } from '#/_base/di/instantiation';

export interface ToolDefinition {
  readonly name: string;
  readonly factory: (accessor: ServicesAccessor) => unknown;
}

export interface IToolDefinitionRegistry {
  readonly _serviceBrand: undefined;
  register(def: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
}

export const IToolDefinitionRegistry: ServiceIdentifier<IToolDefinitionRegistry> =
  createDecorator<IToolDefinitionRegistry>('toolDefinitionRegistry');

export interface ToolCallResult {
  readonly output: string;
}

export interface IToolService {
  readonly _serviceBrand: undefined;
  execute(name: string, args: unknown): Promise<ToolCallResult>;
  list(): readonly ToolDefinition[];
  registerUserTool(def: ToolDefinition): void;
  registerMcpTools(serverId: string, tools: readonly ToolDefinition[]): void;
}

export const IToolService: ServiceIdentifier<IToolService> =
  createDecorator<IToolService>('toolService');
