/**
 * `toolRegistry` domain (L3) — `IAgentToolRegistryService` contract.
 *
 * Per-agent registry of the tools an agent can resolve and run: `register` /
 * `unregister` / `list` / `resolve`, plus `onRegistered` / `onUnregistered`
 * hooks. The tool model types it references (`ExecutableTool`, `ToolInfo`,
 * `ToolSource`) live in the foundational `tool` contract. Bound at Agent
 * scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type { ExecutableTool, ToolInfo, ToolSource } from '#/tool/toolContract';

export interface ToolRegistrationOptions {
  readonly source?: ToolSource;
}

export interface ToolReference {
  readonly name: string;
  readonly source: ToolSource;
}

export interface IAgentToolRegistryService {
  readonly _serviceBrand: undefined;

  register(tool: ExecutableTool, options?: ToolRegistrationOptions): IDisposable;
  list(): readonly ToolInfo[];
  listReferences(): readonly ToolReference[];
  resolve(name: string): ExecutableTool | undefined;
}

export const IAgentToolRegistryService = createDecorator<IAgentToolRegistryService>('agentToolRegistryService');
