import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { ExecutableTool, ToolInfo, ToolSource } from '#/tool/toolContract';
import {
  IAgentToolRegistryService,
  type ToolReference,
  type ToolRegistrationOptions,
} from './toolRegistry';

interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
}

export class AgentToolRegistryService implements IAgentToolRegistryService {
  declare readonly _serviceBrand: undefined;
  private readonly tools = new Map<string, ToolEntry>();

  register(tool: ExecutableTool, options: ToolRegistrationOptions = {}): IDisposable {
    const source = options.source ?? 'builtin';
    const entry: ToolEntry = { tool, source };
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
      .map(({ tool, source }) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        source,
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
