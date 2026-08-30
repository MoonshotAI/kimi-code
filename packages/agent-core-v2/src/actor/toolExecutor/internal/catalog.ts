import { Emitter } from '#/_base/event';
import type {
  AgentToolContribution as AgentToolContributionRecord,
  AgentToolFactoryContext,
} from '#/agent/toolRegistry/toolContribution';
import type { ExecutableTool, ToolDisclosure, ToolInfo, ToolSource } from '#/tool/toolContract';

export interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
  readonly owner: unknown;
}

export interface CatalogSourceEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
}

export interface ToolCatalogState {
  readonly tools: Map<string, ToolEntry>;
  readonly contributionEntries: Map<AgentToolContributionRecord, ToolEntry>;
  readonly changeEmitter: Emitter<void>;
}

export function createToolCatalogState(): ToolCatalogState {
  return {
    tools: new Map(),
    contributionEntries: new Map(),
    changeEmitter: new Emitter<void>(),
  };
}

export interface CatalogContributionDeps {
  readonly factoryContext: AgentToolFactoryContext;
  shouldActivate(record: AgentToolContributionRecord): boolean;
}

export function reconcileCatalogContributions(
  state: ToolCatalogState,
  deps: CatalogContributionDeps,
  records: readonly AgentToolContributionRecord[],
): void {
  const current = new Set(records);
  let changed = false;
  for (const [record, entry] of state.contributionEntries) {
    if (current.has(record)) continue;
    state.contributionEntries.delete(record);
    if (state.tools.get(entry.tool.name) === entry) state.tools.delete(entry.tool.name);
    changed = true;
  }
  for (const record of records) {
    if (state.contributionEntries.has(record)) continue;
    if (!deps.shouldActivate(record)) continue;
    if (record.options.when !== undefined && !record.options.when(deps.factoryContext)) continue;

    const tool = record.options.create(deps.factoryContext);
    const entry: ToolEntry = {
      tool,
      source: record.options.source ?? 'builtin',
      disclosure: record.options.disclosure,
      owner: record,
    };
    state.tools.set(tool.name, entry);
    state.contributionEntries.set(record, entry);
    changed = true;
  }
  if (changed) state.changeEmitter.fire();
}

export function setCatalogSource(
  state: ToolCatalogState,
  owner: unknown,
  entries: readonly CatalogSourceEntry[],
): void {
  let changed = false;
  for (const [name, entry] of state.tools) {
    if (entry.owner !== owner) continue;
    state.tools.delete(name);
    changed = true;
  }
  for (const entry of entries) {
    state.tools.set(entry.tool.name, { ...entry, owner });
    changed = true;
  }
  if (changed) state.changeEmitter.fire();
}

export function catalogList(state: ToolCatalogState): readonly ToolInfo[] {
  return [...state.tools.values()]
    .map(({ tool, source, disclosure }) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      source,
      disclosure,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function catalogListReferences(
  state: ToolCatalogState,
): readonly { readonly name: string; readonly source: ToolSource }[] {
  return [...state.tools.values()]
    .map(({ tool, source }) => ({ name: tool.name, source }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function resolveCatalogTool(state: ToolCatalogState, name: string): ExecutableTool | undefined {
  return state.tools.get(name)?.tool;
}

export interface CatalogView {
  list(): readonly ToolInfo[];
  resolve(name: string): ExecutableTool | undefined;
}

export function catalogViewOf(state: ToolCatalogState): CatalogView {
  return {
    list: () => catalogList(state),
    resolve: (name) => resolveCatalogTool(state, name),
  };
}

export function disposeCatalog(state: ToolCatalogState): void {
  state.contributionEntries.clear();
  state.tools.clear();
  state.changeEmitter.dispose();
}
