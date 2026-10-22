import type { Projection } from '@moonshot-ai/agent-core/store/index';

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

export interface WorkspaceCreatedRecord {
  readonly type: typeof WORKSPACE_CREATED;
  readonly workspace: WorkspaceEntry;
}

export interface WorkspaceUpdatedRecord {
  readonly type: typeof WORKSPACE_UPDATED;
  readonly workspace: WorkspaceEntry;
}

export interface WorkspaceDeletedRecord {
  readonly type: typeof WORKSPACE_DELETED;
  readonly id: string;
  readonly root?: string;
  readonly aliasIds: readonly string[];
}

export interface WorkspaceAliasRecord {
  readonly type: typeof WORKSPACE_ALIAS;
  readonly aliasId: string;
  readonly workspaceId: string;
}

export interface WorkspaceTrustSetRecord {
  readonly type: typeof WORKSPACE_TRUST_SET;
  readonly key: string;
  readonly trusted: boolean;
  readonly trustedAt?: number;
}

export type WorkspacesRecord =
  | WorkspaceCreatedRecord
  | WorkspaceUpdatedRecord
  | WorkspaceDeletedRecord
  | WorkspaceAliasRecord
  | WorkspaceTrustSetRecord;

export interface WorkspacesState {
  readonly workspaces: ReadonlyMap<string, WorkspaceEntry>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly deletedIds: ReadonlySet<string>;
  readonly trust: ReadonlyMap<string, number>;
}

export const workspacesProjection: Projection<WorkspacesState, WorkspacesRecord> = {
  initial: () => ({
    workspaces: new Map(),
    aliases: new Map(),
    deletedIds: new Set(),
    trust: new Map(),
  }),
  reduce: (state, entry) => {
    const event = entry.event;
    if (event.type === WORKSPACE_CREATED) {
      const { workspace } = event;
      const workspaces = new Map([...state.workspaces, [workspace.id, workspace]]);
      const deletedIds = new Set(state.deletedIds);
      deletedIds.delete(workspace.id);
      return { ...state, workspaces, deletedIds };
    }
    if (event.type === WORKSPACE_UPDATED) {
      const { workspace } = event;
      if (!state.workspaces.has(workspace.id)) return state;
      const workspaces = new Map([...state.workspaces, [workspace.id, workspace]]);
      return { ...state, workspaces };
    }
    if (event.type === WORKSPACE_DELETED) {
      const { id, root, aliasIds } = event;
      let workspaces = new Map(state.workspaces);
      let aliases = new Map(state.aliases);
      if (root !== undefined) {
        const rootKey = workspaceRootKey(root);
        const removed = new Set<string>();
        for (const [entryId, workspace] of workspaces) {
          if (workspaceRootKey(workspace.root) === rootKey) {
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
      const { aliasId, workspaceId } = event;
      if (state.aliases.get(aliasId) === workspaceId) return state;
      const aliases = new Map([...state.aliases, [aliasId, workspaceId]]);
      return { ...state, aliases };
    }
    if (event.type === WORKSPACE_TRUST_SET) {
      const { key, trusted } = event;
      const trust = new Map(state.trust);
      if (trusted) {
        trust.set(key, event.trustedAt as number);
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
