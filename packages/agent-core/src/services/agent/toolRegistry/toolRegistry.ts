import { createDecorator, type IDisposable } from '../../../di';
import type { ExecutableTool } from '../../../loop';

import type { Hooks } from '../hooks';
import type { ToolInfo, ToolSource } from '../types';

export interface ToolRegistrationOptions {
  readonly source?: ToolSource;
}

export interface IToolRegistry {
  register(tool: ExecutableTool, options?: ToolRegistrationOptions): IDisposable;
  list(): readonly ToolInfo[];
  resolve(name: string): ExecutableTool | undefined;

  readonly hooks: Hooks<{
    onRegistered: { tool: ExecutableTool };
    onUnregistered: { tool: ExecutableTool };
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolRegistry = createDecorator<IToolRegistry>('agentToolRegistryService');
