/**
 * `tool` domain (L3) — `IToolDefinitionRegistry` + `IToolService`.
 *
 * The registry collects `ToolDefinition` contributions (name + factory).
 * `ToolService` assembles the per-agent tool set (builtin from the registry,
 * plus runtime user / mcp tools) and routes `execute` by name. Tools are
 * built lazily via their factory with a `ServicesAccessor` backed by the
 * Agent scope's `IInstantiationService`.
 */

import { InstantiationType } from '#/_base/di/extensions';
import {
  IInstantiationService,
  type ServiceIdentifier,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentConfigService } from '#/config/config';
import { IAgentKaos } from '#/kaos/kaos';
import { ILLMService } from '#/kosong/kosong';
import { IPermissionService } from '#/permission/permission';
import { IAgentRecords } from '#/records/records';

import {
  type ToolCallResult,
  type ToolDefinition,
  IToolDefinitionRegistry,
  IToolService,
} from './tool';

interface ExecutableTool {
  execute(args: unknown): Promise<ToolCallResult>;
}

function asExecutable(instance: unknown): ExecutableTool {
  if (
    typeof instance === 'object' &&
    instance !== null &&
    typeof (instance as { execute?: unknown }).execute === 'function'
  ) {
    return instance as ExecutableTool;
  }
  throw new Error('tool factory did not return an executable tool (missing execute)');
}

export class ToolDefinitionRegistry implements IToolDefinitionRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly defs = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    this.defs.set(def.name, def);
  }
  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }
  list(): readonly ToolDefinition[] {
    return [...this.defs.values()];
  }
}

export class ToolService implements IToolService {
  declare readonly _serviceBrand: undefined;
  private readonly user = new Map<string, ToolDefinition>();
  private readonly mcp = new Map<string, ToolDefinition>();
  private readonly accessor: ServicesAccessor;

  constructor(
    @IToolDefinitionRegistry private readonly registry: IToolDefinitionRegistry,
    @IAgentConfigService _agentConfig: IAgentConfigService,
    @IAgentRecords _records: IAgentRecords,
    @IAgentKaos _agentKaos: IAgentKaos,
    @IPermissionService _permission: IPermissionService,
    @ILLMService _llm: ILLMService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    this.accessor = {
      get: <T>(id: ServiceIdentifier<T>): T => instantiation.invokeFunction((a) => a.get(id)),
    };
  }

  private build(def: ToolDefinition): ExecutableTool {
    return asExecutable(def.factory(this.accessor));
  }

  private find(name: string): ToolDefinition | undefined {
    return this.user.get(name) ?? this.mcp.get(name) ?? this.registry.get(name);
  }

  async execute(name: string, args: unknown): Promise<ToolCallResult> {
    const def = this.find(name);
    if (def === undefined) {
      throw new Error(`ToolService.execute: unknown tool '${name}'`);
    }
    return this.build(def).execute(args);
  }

  list(): readonly ToolDefinition[] {
    return [...this.registry.list(), ...this.user.values(), ...this.mcp.values()];
  }

  registerUserTool(def: ToolDefinition): void {
    this.user.set(def.name, def);
  }

  registerMcpTools(serverId: string, tools: readonly ToolDefinition[]): void {
    for (const def of tools) {
      this.mcp.set(`${serverId}:${def.name}`, def);
    }
  }
}

registerScopedService(LifecycleScope.Core, IToolDefinitionRegistry, ToolDefinitionRegistry, InstantiationType.Delayed, 'tool');
registerScopedService(LifecycleScope.Agent, IToolService, ToolService, InstantiationType.Delayed, 'tool');
