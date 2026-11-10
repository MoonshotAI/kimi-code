import { toDisposable } from "#/_base/di/lifecycle";
import { LifecycleScope } from "#/app/scopes";
import { ScopeActivation, registerScopedService } from "#/_base/di/scope";
import {
  toolDefinitionVersionSignature,
  type ExecutableTool,
  type ToolDisclosure,
  type ToolInfo,
  type ToolSource,
} from "#/tool/toolContract";
import {
  IAgentToolRegistryService,
  type ToolReference,
  type ToolRegistration,
  type ToolRegistrationOptions,
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
  private readonly pendingTools = new Map<string, ToolEntry>();

  register(tool: ExecutableTool, options: ToolRegistrationOptions = {}): ToolRegistration {
    const source = options.source ?? 'builtin';
    const candidate = createEntry(tool, source, options.disclosure);
    const current = this.tools.get(tool.name);
    if (current === undefined) {
      this.pendingTools.delete(tool.name);
      this.tools.set(tool.name, candidate);
      return this.registration(candidate, 'active');
    }
    if (toolDefinitionVersionSignature(current.info) === toolDefinitionVersionSignature(candidate.info)) {
      const replacement = { ...candidate, info: current.info };
      this.pendingTools.delete(tool.name);
      this.tools.set(tool.name, replacement);
      return this.registration(replacement, 'active');
    }
    this.pendingTools.set(tool.name, candidate);
    return this.registration(candidate, 'pending');
  }

  list(): readonly ToolInfo[] {
    return [...this.tools.values()]
      .map((entry) => this.pendingTools.has(entry.tool.name) ? { ...entry.info } : liveInfo(entry))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listLive(): readonly ToolInfo[] {
    const live = new Map([...this.tools.values()].map((entry) => [entry.tool.name, liveInfo(entry)]));
    for (const entry of this.pendingTools.values()) live.set(entry.tool.name, entry.info);
    return [...live.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listReferences(): readonly ToolReference[] {
    return [...this.tools.entries()]
      .map(([name, { source }]) => ({ name, source }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  resolve(name: string): ExecutableTool | undefined {
    return this.tools.get(name)?.tool;
  }

  private registration(
    entry: ToolEntry,
    status: NonNullable<ToolRegistration['status']>,
  ): ToolRegistration {
    const disposable = toDisposable(() => {
      if (status === 'pending') {
        if (this.pendingTools.get(entry.tool.name) === entry) this.pendingTools.delete(entry.tool.name);
        return;
      }
      if (this.tools.get(entry.tool.name) === entry) this.unregisterTool(entry.tool.name);
    });
    return {
      status,
      dispose: () => {
        disposable.dispose();
      },
    };
  }

  private unregisterTool(name: string): ToolEntry | undefined {
    const entry = this.tools.get(name);
    this.pendingTools.delete(name);
    if (entry === undefined) return undefined;
    this.tools.delete(name);
    return entry;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolRegistryService,
  AgentToolRegistryService,
  ScopeActivation.OnScopeCreated,
  'toolRegistry',
);
