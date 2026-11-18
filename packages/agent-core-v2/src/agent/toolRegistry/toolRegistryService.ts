import { toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  type ExecutableTool,
  type ToolDisclosure,
  type ToolInfo,
  type ToolSource,
} from '#/tool/toolContract';
import {
  IAgentToolRegistryService,
  type ToolReference,
  type ToolRegistration,
  type ToolRegistrationOptions,
  type ToolRegistryChange,
} from './toolRegistry';

import './builtinToolAssemblyService';

interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
  readonly info: ToolInfo;
}

function createEntry(tool: ExecutableTool, source: ToolSource, disclosure?: ToolDisclosure): ToolEntry {
  return {
    tool,
    source,
    disclosure,
    info: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters === undefined ? undefined : structuredClone(tool.parameters),
      source,
      disclosure,
    },
  };
}

function liveInfo(entry: ToolEntry): ToolInfo {
  return {
    name: entry.tool.name,
    description: entry.tool.description,
    parameters: entry.tool.parameters,
    source: entry.source,
    disclosure: entry.disclosure,
  };
}

export class AgentToolRegistryService implements IAgentToolRegistryService {
  declare readonly _serviceBrand: undefined;
  private readonly tools = new Map<string, ToolEntry>();
  private readonly listeners = new Set<(change: ToolRegistryChange) => void>();

  register(tool: ExecutableTool, options: ToolRegistrationOptions = {}): ToolRegistration {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered; unregister it before registering again`);
    }
    const candidate = createEntry(tool, options.source ?? 'builtin', options.disclosure);
    this.tools.set(tool.name, candidate);
    this.emit({ type: 'registered', tool });
    return this.registration(candidate);
  }

  unregister(name: string): boolean {
    const entry = this.tools.get(name);
    if (entry === undefined) return false;
    this.tools.delete(name);
    this.emit({ type: 'unregistered', tool: entry.tool });
    return true;
  }

  list(): readonly ToolInfo[] {
    return [...this.tools.values()]
      .map((entry) => liveInfo(entry))
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

  onDidChange(listener: (change: ToolRegistryChange) => void) {
    this.listeners.add(listener);
    return toDisposable(() => {
      this.listeners.delete(listener);
    });
  }

  private emit(change: ToolRegistryChange): void {
    for (const listener of Array.from(this.listeners)) listener(change);
  }

  private registration(entry: ToolEntry): ToolRegistration {
    const disposable = toDisposable(() => {
      if (this.tools.get(entry.tool.name) === entry) this.unregister(entry.tool.name);
    });
    return {
      dispose: () => {
        disposable.dispose();
      },
    };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolRegistryService,
  AgentToolRegistryService,
  ScopeActivation.OnScopeCreated,
  'toolRegistry',
);
