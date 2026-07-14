/**
 * `workspaceRegistry` domain (L2) — `IWorkspaceQueryService` implementation.
 *
 * Combines the explicit workspace catalog with active sessions from
 * `sessionIndex`. Resolves workspace aliases through their normalized root,
 * falls back from legacy sessions without `cwd` to the registered root, and
 * excludes archived sessions from workspace counts and recent-session lists.
 * Bound at App scope.
 */

import { basename } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { encodeWorkDirKey, normalizeWorkDir } from '#/_base/utils/workdir-slug';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';

import {
  IWorkspaceRegistry,
  type Workspace,
  type WorkspaceRegistrySnapshot,
} from './workspaceRegistry';
import {
  IWorkspaceQueryService,
  RECENT_SESSIONS_LIMIT,
  type WorkspaceListItem,
} from './workspaceQuery';

export class WorkspaceQueryService implements IWorkspaceQueryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceRegistry private readonly registry: IWorkspaceRegistry,
    @ISessionIndex private readonly index: ISessionIndex,
  ) {}

  async list(): Promise<readonly WorkspaceListItem[]> {
    const [snapshot, page] = await Promise.all([
      this.registry.snapshot(),
      this.index.list({}),
    ]);
    const resolveRoot = createSessionRootResolver(snapshot, this.registry);
    const deletedRoots = normalizedDeletedRoots(snapshot);
    const byRoot = new Map<
      string,
      { workspace: WorkspaceListItem; registered: boolean; canonical: boolean }
    >();

    for (const workspace of snapshot.workspaces) {
      const root = normalizeWorkDir(workspace.root);
      if (isDeleted(snapshot, workspace.id, root, deletedRoots)) continue;
      const canonicalId = encodeWorkDirKey(root);
      const candidate: WorkspaceListItem = {
        ...workspace,
        root,
        sessionCount: 0,
      };
      const existing = byRoot.get(root);
      const canonical = workspace.id === canonicalId;
      if (existing === undefined || (!existing.canonical && canonical)) {
        byRoot.set(root, { workspace: candidate, registered: true, canonical });
      }
    }

    for (const session of page.items) {
      const root = await resolveRoot(session);
      if (root === undefined || isDeleted(snapshot, session.workspaceId, root, deletedRoots)) {
        continue;
      }
      const existing = byRoot.get(root);
      if (existing === undefined) {
        byRoot.set(root, {
          workspace: {
            id: session.workspaceId,
            root,
            name: basename(root),
            createdAt: finiteTimestamp(session.createdAt),
            lastOpenedAt: finiteTimestamp(session.updatedAt),
            sessionCount: 1,
          },
          registered: false,
          canonical: session.workspaceId === encodeWorkDirKey(root),
        });
        continue;
      }
      const workspace = existing.workspace;
      const canonicalId = encodeWorkDirKey(root);
      const shouldPromote =
        !existing.registered && !existing.canonical && session.workspaceId === canonicalId;
      byRoot.set(root, {
        ...existing,
        canonical: existing.canonical || shouldPromote,
        workspace: {
          ...workspace,
          ...(shouldPromote ? { id: canonicalId } : {}),
          createdAt: existing.registered
            ? workspace.createdAt
            : Math.min(workspace.createdAt, finiteTimestamp(session.createdAt)),
          lastOpenedAt: existing.registered
            ? workspace.lastOpenedAt
            : Math.max(workspace.lastOpenedAt, finiteTimestamp(session.updatedAt)),
          sessionCount: workspace.sessionCount + 1,
        },
      });
    }

    return [...byRoot.values()]
      .map(({ workspace }) => workspace)
      .toSorted((left, right) =>
        right.lastOpenedAt - left.lastOpenedAt || left.id.localeCompare(right.id),
      );
  }

  async get(workspaceId: string): Promise<Workspace | undefined> {
    const snapshot = await this.registry.snapshot();
    const registered = resolveRegisteredWorkspace(snapshot, workspaceId);
    if (registered !== undefined) return registered;

    const page = await this.index.list({ includeArchived: true });
    const resolveRoot = createSessionRootResolver(snapshot, this.registry);
    const sessions = await sessionsForWorkspace(page.items, snapshot, workspaceId, resolveRoot);
    return deriveWorkspace(sessions, resolveRoot);
  }

  async listSessions(
    workspaceId: string,
    options?: { readonly includeArchived?: boolean },
  ): Promise<readonly SessionSummary[]> {
    const snapshot = await this.registry.snapshot();
    const page = await this.index.list({ includeArchived: options?.includeArchived });
    const resolveRoot = createSessionRootResolver(snapshot, this.registry);
    return (await sessionsForWorkspace(page.items, snapshot, workspaceId, resolveRoot)).toSorted(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
  }

  async countActiveSessions(workspaceId: string): Promise<number> {
    return (await this.listSessions(workspaceId)).length;
  }

  async listRecentSessions(workspaceId: string): Promise<readonly SessionSummary[]> {
    return (await this.listSessions(workspaceId)).slice(0, RECENT_SESSIONS_LIMIT);
  }
}

function resolveRegisteredWorkspace(
  snapshot: WorkspaceRegistrySnapshot,
  workspaceId: string,
): Workspace | undefined {
  if (snapshot.deletedWorkspaceIds.has(workspaceId)) return undefined;
  const workspace = findRepresentativeWorkspace(snapshot.workspaces, workspaceId);
  if (workspace === undefined) return undefined;
  const root = normalizeWorkDir(workspace.root);
  if (
    normalizedDeletedRoots(snapshot).has(root) ||
    snapshot.deletedWorkspaceIds.has(encodeWorkDirKey(root))
  ) {
    return undefined;
  }
  return { ...workspace, root };
}

function findRepresentativeWorkspace(
  workspaces: readonly Workspace[],
  workspaceId: string,
): Workspace | undefined {
  const exact = workspaces.find((workspace) => workspace.id === workspaceId);
  const candidates =
    exact === undefined
      ? workspaces.filter(
          (workspace) => encodeWorkDirKey(normalizeWorkDir(workspace.root)) === workspaceId,
        )
      : workspaces.filter(
          (workspace) =>
            normalizeWorkDir(workspace.root) === normalizeWorkDir(exact.root),
        );
  if (candidates.length === 0) return undefined;
  const root = normalizeWorkDir(candidates[0]!.root);
  const canonicalId = encodeWorkDirKey(root);
  return candidates.find((workspace) => workspace.id === canonicalId) ?? candidates[0];
}

async function sessionsForWorkspace(
  sessions: readonly SessionSummary[],
  snapshot: WorkspaceRegistrySnapshot,
  workspaceId: string,
  resolveRoot: SessionRootResolver,
): Promise<SessionSummary[]> {
  const registered = resolveRegisteredWorkspace(snapshot, workspaceId);
  const requestedRoot =
    registered?.root ?? (await rootForWorkspaceId(sessions, workspaceId, resolveRoot));
  const deletedRoots = normalizedDeletedRoots(snapshot);
  if (snapshot.deletedWorkspaceIds.has(workspaceId)) return [];
  const matching: SessionSummary[] = [];
  for (const session of sessions) {
    const root = await resolveRoot(session);
    if (root === undefined || isDeleted(snapshot, session.workspaceId, root, deletedRoots)) {
      continue;
    }
    if (requestedRoot !== undefined) {
      if (root === requestedRoot) matching.push(session);
      continue;
    }
    if (session.workspaceId === workspaceId || encodeWorkDirKey(root) === workspaceId) {
      matching.push(session);
    }
  }
  return matching;
}

async function rootForWorkspaceId(
  sessions: readonly SessionSummary[],
  workspaceId: string,
  resolveRoot: SessionRootResolver,
): Promise<string | undefined> {
  const matching = sessions.find((session) => session.workspaceId === workspaceId);
  return matching === undefined ? undefined : resolveRoot(matching);
}

type SessionRootResolver = (session: SessionSummary) => Promise<string | undefined>;

function createSessionRootResolver(
  snapshot: WorkspaceRegistrySnapshot,
  registry: IWorkspaceRegistry,
): SessionRootResolver {
  const fallbackRoots = new Map<string, string | undefined>();
  return async (session) => {
    if (session.cwd !== undefined && session.cwd.trim() !== '') {
      return normalizeWorkDir(session.cwd);
    }
    if (fallbackRoots.has(session.workspaceId)) {
      return fallbackRoots.get(session.workspaceId);
    }
    const registered = resolveRegisteredWorkspace(snapshot, session.workspaceId);
    if (registered !== undefined) {
      fallbackRoots.set(session.workspaceId, registered.root);
      return registered.root;
    }
    const resolved = await registry.get(session.workspaceId);
    const root = resolved === undefined ? undefined : normalizeWorkDir(resolved.root);
    fallbackRoots.set(session.workspaceId, root);
    return root;
  };
}

async function deriveWorkspace(
  sessions: readonly SessionSummary[],
  resolveRoot: SessionRootResolver,
): Promise<Workspace | undefined> {
  if (sessions.length === 0) return undefined;
  const roots = await Promise.all(sessions.map((session) => resolveRoot(session)));
  const root = roots
    .find((candidate): candidate is string => candidate !== undefined);
  if (root === undefined) return undefined;
  const representativeId = representativeSessionWorkspaceId(sessions, roots, root);
  return {
    id: representativeId,
    root,
    name: basename(root),
    createdAt: Math.min(...sessions.map((session) => finiteTimestamp(session.createdAt))),
    lastOpenedAt: Math.max(...sessions.map((session) => finiteTimestamp(session.updatedAt))),
  };
}

function representativeSessionWorkspaceId(
  sessions: readonly SessionSummary[],
  roots: readonly (string | undefined)[],
  root: string,
): string {
  const canonicalId = encodeWorkDirKey(root);
  if (
    sessions.some((session, index) => session.workspaceId === canonicalId && roots[index] === root)
  ) {
    return canonicalId;
  }
  return sessions.find((session, index) => roots[index] === root)?.workspaceId ?? canonicalId;
}

function normalizedDeletedRoots(snapshot: WorkspaceRegistrySnapshot): ReadonlySet<string> {
  const roots = new Set(
    [...snapshot.deletedWorkspaceRoots.values()].map((root) => normalizeWorkDir(root)),
  );
  for (const workspace of snapshot.workspaces) {
    if (snapshot.deletedWorkspaceIds.has(workspace.id)) {
      roots.add(normalizeWorkDir(workspace.root));
    }
  }
  return roots;
}

function isDeleted(
  snapshot: WorkspaceRegistrySnapshot,
  workspaceId: string,
  root: string,
  deletedRoots: ReadonlySet<string>,
): boolean {
  return (
    snapshot.deletedWorkspaceIds.has(workspaceId) ||
    snapshot.deletedWorkspaceIds.has(encodeWorkDirKey(root)) ||
    deletedRoots.has(root)
  );
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceQueryService,
  WorkspaceQueryService,
  InstantiationType.Eager,
  'workspaceRegistry',
);
