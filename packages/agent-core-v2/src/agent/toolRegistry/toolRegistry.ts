import { createDecorator } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolInfo,
  ToolSource,
} from '#/tool/toolContract';

export interface ToolRegistrationOptions {
  readonly source?: ToolSource;
  readonly disclosure?: ToolDisclosure;
}

export interface ToolReference {
  readonly name: string;
  readonly source: ToolSource;
}

export interface ToolRegistration extends IDisposable {}

export interface ToolRegistryChange {
  readonly type: 'registered' | 'unregistered';
  readonly tool: ExecutableTool;
}

export interface IAgentToolRegistryService {
  readonly _serviceBrand: undefined;

  register(tool: ExecutableTool, options?: ToolRegistrationOptions): ToolRegistration;
  unregister(name: string): boolean;
  list(): readonly ToolInfo[];
  listReferences(): readonly ToolReference[];
  resolve(name: string): ExecutableTool | undefined;
  onDidChange(listener: (change: ToolRegistryChange) => void): IDisposable;
}

export const IAgentToolRegistryService = createDecorator<IAgentToolRegistryService>('agentToolRegistryService');
