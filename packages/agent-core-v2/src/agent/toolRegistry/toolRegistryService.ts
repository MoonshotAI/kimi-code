/**
 * `toolRegistry` domain (L3) — `IAgentToolRegistryService` implementation.
 *
 * The per-agent tool table (`tools`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it. Bound at Agent scope.
 */

import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentStateService } from '#/agent/state/agentState';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolInfo,
  ToolSource,
} from '#/tool/toolContract';
import {
  IAgentToolRegistryService,
  type ToolReference,
  type ToolRegistrationOptions,
} from './toolRegistry';

interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
}

export const toolRegistryToolsKey = defineState<Map<string, ToolEntry>>(
  'toolRegistry.tools',
  () => new Map(),
);

export class AgentToolRegistryService implements IAgentToolRegistryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    this.states.register(toolRegistryToolsKey);
  }

  private get tools(): Map<string, ToolEntry> {
    return this.states.get(toolRegistryToolsKey);
  }

  register(tool: ExecutableTool, options: ToolRegistrationOptions = {}): IDisposable {
    const source = options.source ?? 'builtin';
    const entry: ToolEntry = { tool, source, disclosure: options.disclosure };
    this.unregisterTool(tool.name);
    this.tools.set(tool.name, entry);

    return toDisposable(() => {
      const current = this.tools.get(tool.name);
      if (current !== entry) return;
      this.unregisterTool(tool.name);
    });
  }

  list(): readonly ToolInfo[] {
    return [...this.tools.values()]
      .map(({ tool, source, disclosure }) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        source,
        disclosure,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listReferences(): readonly ToolReference[] {
    return [...this.tools.entries()]
      .map(([name, { source }]) => ({ name, source }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  resolve(name: string): ExecutableTool | undefined {
    return this.tools.get(name)?.tool;
  }

  private unregisterTool(name: string): ToolEntry | undefined {
    const entry = this.tools.get(name);
    if (entry === undefined) return undefined;
    this.tools.delete(name);
    return entry;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolRegistryService,
  AgentToolRegistryService,
  InstantiationType.Eager,
  'toolRegistry',
);
