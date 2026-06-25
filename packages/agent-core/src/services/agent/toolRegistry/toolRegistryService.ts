import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
  toDisposable,
  type IDisposable,
} from '../../../di';
import type { ExecutableTool } from '../../../loop';
import { OrderedHookSlot } from '../hooks';
import type { ToolInfo, ToolSource } from '../types';
import { IToolRegistry, type ToolRegistrationOptions } from './toolRegistry';

interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
}

export class ToolRegistryService extends Disposable implements IToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();

  readonly hooks = {
    onRegistered: new OrderedHookSlot<{ tool: ExecutableTool }>(),
    onUnregistered: new OrderedHookSlot<{ tool: ExecutableTool }>(),
  };

  constructor() {
    super();
  }

  register(tool: ExecutableTool, options: ToolRegistrationOptions = {}): IDisposable {
    const source = options.source ?? 'builtin';
    const entry: ToolEntry = { tool, source };
    this.unregisterTool(tool.name);
    this.tools.set(tool.name, entry);

    void this.hooks.onRegistered.run({ tool: entry.tool });

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

  resolve(name: string): ExecutableTool | undefined {
    return this.tools.get(name)?.tool;
  }

  private unregisterTool(name: string): ToolEntry | undefined {
    const entry = this.tools.get(name);
    if (entry === undefined) return undefined;
    this.tools.delete(name);
    void this.hooks.onUnregistered.run({ tool: entry.tool });
    return entry;
  }
}

registerSingleton(IToolRegistry, new SyncDescriptor(ToolRegistryService, [], true));
