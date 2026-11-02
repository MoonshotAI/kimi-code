import { createDecorator } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type { EnvironmentHandle } from '#/environment/environment';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolInfo,
  ToolSource,
} from '#/tool/toolContract';

export interface ToolRegistrationOptions {
  readonly source?: ToolSource;
  readonly disclosure?: ToolDisclosure;
  readonly environmentScoped?: boolean;
}

export interface ToolReference {
  readonly name: string;
  readonly source: ToolSource;
}

export interface ToolEnvironmentRoute {
  readonly args: unknown;
  readonly environment?: EnvironmentHandle;
  readonly error?: string;
}

export const ENVIRONMENT_ARGUMENT = 'environment';

export interface IAgentToolRegistryService {
  readonly _serviceBrand: undefined;

  register(tool: ExecutableTool, options?: ToolRegistrationOptions): IDisposable;
  list(): readonly ToolInfo[];
  listReferences(): readonly ToolReference[];
  resolve(name: string): ExecutableTool | undefined;
  routeEnvironment(name: string, args: unknown): ToolEnvironmentRoute;
}

export const IAgentToolRegistryService = createDecorator<IAgentToolRegistryService>('agentToolRegistryService');
