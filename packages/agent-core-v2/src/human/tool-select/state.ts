import type { ModelCapability } from '#/llm/capability';
import type { ToolDescription } from '#/llm/message';
import type { ToolDefinition } from '#/tool/tool';

export const SELECT_TOOLS_TOOL_NAME = 'select_tools';

export interface LoadToolsResult {
  readonly toLoad: readonly string[];
  readonly alreadyAvailable: readonly string[];
  readonly unknown: readonly string[];
}

export interface ToolSelectState {
  enabled(): boolean;
  isLoadable(name: string): boolean;
  isLoaded(name: string): boolean;
  load(names: readonly string[]): LoadToolsResult;
  pendingSchemas(): ToolDescription[];
  announcement(): string | undefined;
  markSchemasLanded(): void;
  markAnnounced(): void;
  reset(): void;
}

export interface CreateToolSelectStateOptions {
  loadable: () => readonly ToolDefinition[];
  enabled: () => boolean;
}

export function isToolSelectEnabled(capability: ModelCapability): boolean {
  return capability.dynamically_loaded_tools === true && capability.tool_use;
}

export function renderLoadableToolsAnnouncement(
  added: readonly string[],
  removed: readonly string[],
): string {
  const sections: string[] = [];
  if (added.length > 0) {
    sections.push(`<tools_added>\n${added.join('\n')}\n</tools_added>`);
  }
  if (removed.length > 0) {
    sections.push(`<tools_removed>\n${removed.join('\n')}\n</tools_removed>`);
  }
  sections.push(
    'Use the select_tools tool with exact names to load full tool definitions before calling them. ' +
      'Names listed as removed are no longer loadable — do not select them. ' +
      'Fold all announcements in this conversation in order to get the current list.',
  );
  return sections.join('\n\n');
}

export function createToolSelectState({
  loadable,
  enabled,
}: CreateToolSelectStateOptions): ToolSelectState {
  const pending = new Set<string>();
  const landed = new Set<string>();
  const announced = new Set<string>();
  let pendingAnnouncement: { added: string[]; removed: string[] } | undefined;

  const loadableNames = () => new Set(loadable().map((tool) => tool.name));

  const schemaOf = (name: string): ToolDescription | undefined => {
    const tool = loadable().find((entry) => entry.name === name);
    if (tool === undefined) return undefined;
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  };

  return {
    enabled,
    isLoadable: (name) => loadableNames().has(name),
    isLoaded: (name) => pending.has(name) || landed.has(name),
    load: (names) => {
      const loadableSet = loadableNames();
      const toLoad: string[] = [];
      const alreadyAvailable: string[] = [];
      const unknown: string[] = [];
      for (const name of new Set(names)) {
        if (pending.has(name) || landed.has(name)) {
          alreadyAvailable.push(name);
        } else if (loadableSet.has(name)) {
          toLoad.push(name);
        } else {
          unknown.push(name);
        }
      }
      for (const name of toLoad) pending.add(name);
      return { toLoad, alreadyAvailable, unknown };
    },
    pendingSchemas: () =>
      [...pending]
        .toSorted((a, b) => a.localeCompare(b))
        .flatMap((name) => {
          const schema = schemaOf(name);
          return schema === undefined ? [] : [schema];
        }),
    announcement: () => {
      if (!enabled()) return undefined;
      const names = loadable()
        .map((tool) => tool.name)
        .toSorted((a, b) => a.localeCompare(b));
      const namesSet = new Set(names);
      const added = names.filter((name) => !announced.has(name));
      const removed = [...announced]
        .filter((name) => !namesSet.has(name))
        .toSorted((a, b) => a.localeCompare(b));
      if (added.length === 0 && removed.length === 0) return undefined;
      pendingAnnouncement = { added, removed };
      return renderLoadableToolsAnnouncement(added, removed);
    },
    markSchemasLanded: () => {
      for (const name of pending) landed.add(name);
      pending.clear();
    },
    markAnnounced: () => {
      if (pendingAnnouncement === undefined) return;
      for (const name of pendingAnnouncement.added) announced.add(name);
      for (const name of pendingAnnouncement.removed) announced.delete(name);
      pendingAnnouncement = undefined;
    },
    reset: () => {
      pending.clear();
      landed.clear();
      announced.clear();
      pendingAnnouncement = undefined;
    },
  };
}
