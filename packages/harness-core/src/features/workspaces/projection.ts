import type { Projection, RecordEvent } from '@moonshot-ai/agent-core';

import { encodeWorkDirKey, workspaceRootKey } from './keys';

export const WORKSPACE_CREATED = 'workspace.created';
export const WORKSPACE_UPDATED = 'workspace.updated';
export const WORKSPACE_DELETED = 'workspace.deleted';
export const WORKSPACE_ALIAS = 'workspace.alias';
export const WORKSPACE_TRUST_SET = 'workspace.trust.set';

export interface WorkspaceEntry {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspacePatch {
  readonly name?: string;
}

export interface WorkspacesState {
  readonly workspaces: ReadonlyMap<string, WorkspaceEntry>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly deletedIds: ReadonlySet<string>;
  readonly trust: ReadonlyMap<string, number>;
}

function readWorkspace(event: RecordEvent): WorkspaceEntry {
  return event['workspace'] as WorkspaceEntry;
}

export const workspacesProjection: Projection<WorkspacesState, RecordEvent, number> = {
  initial: () => ({
    workspaces: new Map(),
    aliases: new Map(),
    deletedIds: new Set(),
    trust: new Map(),
  }),
  reduce: (state, event) => {
    if (event.type === WORKSPACE_CREATED) {
      const workspace = readWorkspace(event);
      const workspaces = new Map([...state.workspaces, [workspace.id, workspace]]);
      const deletedIds = new Set(state.deletedIds);
      deletedIds.delete(workspace.id);
      return { ...state, workspaces, deletedIds };
    }
    if (event.type === WORKSPACE_UPDATED) {
      const workspace = readWorkspace(event);
      if (!state.workspaces.has(workspace.id)) return state;
      const workspaces = new Map([...state.workspaces, [workspace.id, workspace]]);
      return { ...state, workspaces };
    }
    if (event.type === WORKSPACE_DELETED) {
      const id = event['id'] as string;
      const root = event['root'] as string | undefined;
      const aliasIds = (event['aliasIds'] as readonly string[] | undefined) ?? [];
      let workspaces = new Map(state.workspaces);
      let aliases = new Map(state.aliases);
      if (root !== undefined) {
        const rootKey = workspaceRootKey(root);
        const removed = new Set<string>();
        for (const [entryId, entry] of workspaces) {
          if (workspaceRootKey(entry.root) === rootKey) {
            workspaces.delete(entryId);
            removed.add(entryId);
          }
        }
        aliases = new Map(state.aliases);
        for (const [aliasId, canonicalId] of aliases) {
          if (removed.has(canonicalId) || aliasIds.includes(aliasId) || aliasId === id) {
            aliases.delete(aliasId);
          }
        }
      }
      const deletedIds = new Set([...state.deletedIds, id, ...aliasIds]);
      return { workspaces, aliases, deletedIds, trust: state.trust };
    }
    if (event.type === WORKSPACE_ALIAS) {
      const aliasId = event['aliasId'] as string;
      const workspaceId = event['workspaceId'] as string;
      if (state.aliases.get(aliasId) === workspaceId) return state;
      const aliases = new Map([...state.aliases, [aliasId, workspaceId]]);
      return { ...state, aliases };
    }
    if (event.type === WORKSPACE_TRUST_SET) {
      const key = event['key'] as string;
      const trusted = event['trusted'] === true;
      const trust = new Map(state.trust);
      if (trusted) {
        trust.set(key, event['trustedAt'] as number);
      } else {
        trust.delete(key);
      }
      return { ...state, trust };
    }
    return state;
  },
};

export function resolveWorkspaceId(state: WorkspacesState, id: string): string {
  return state.workspaces.has(id) ? id : (state.aliases.get(id) ?? id);
}

export function getWorkspaceEntry(state: WorkspacesState, id: string): WorkspaceEntry | undefined {
  return state.workspaces.get(id) ?? state.workspaces.get(state.aliases.get(id) ?? '');
}

export function dedupeWorkspacesByRoot(state: WorkspacesState): WorkspaceEntry[] {
  const byRoot = new Map<string, WorkspaceEntry>();
  for (const workspace of state.workspaces.values()) {
    const rootKey = workspaceRootKey(workspace.root);
    const existing = byRoot.get(rootKey);
    if (existing === undefined) {
      byRoot.set(rootKey, workspace);
      continue;
    }
    const canonicalId = encodeWorkDirKey(workspace.root);
    if (existing.id !== canonicalId && workspace.id === canonicalId) {
      byRoot.set(rootKey, workspace);
    }
  }
  return [...byRoot.values()];
}
