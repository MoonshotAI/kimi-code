import {
  createFacadeToken,
  createFeature,
  openStore,
  useApp,
  useCleanup,
  useOnApp,
  type Entry,
  type FeatureSpec,
  type Journal,
  type OpenSessionInput,
  type RecordEvent,
  type SessionHandle,
} from '@moonshot-ai/agent-core';
import {
  shallowRef,
  useExpose,
  useFire,
  useReady,
  type RuntimeEvent,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import type { HostFileStat, OsFsPort, OsHost } from '#/features/os/host/types';

import { createHostFsBrowser, type FsContentProbe } from './browse';
import { mapHostFsError, WorkspaceFsError } from './errors';
import { createWorkspaceGit, type WorkspaceGitPort } from './git';
import { encodeWorkDirKey, workspaceRootKey, workspaceTrustKey } from './keys';
import { sessionWorkspaceId, withSessionWorkspace } from './session';
import {
  dedupeWorkspacesByRoot,
  getWorkspaceEntry,
  WORKSPACE_ALIAS,
  WORKSPACE_CREATED,
  WORKSPACE_DELETED,
  WORKSPACE_TRUST_SET,
  WORKSPACE_UPDATED,
  workspacesProjection,
  type WorkspaceEntry,
  type WorkspacePatch,
  type WorkspacesState,
} from './projection';
import { createWorkspaceFsView, type WorkspaceFsRoots, type WorkspaceFsView } from './view';
import type {
  AddDirResult,
  FsBrowseResponse,
  FsHomeResponse,
} from './wire';

export interface WorkspaceCreatedEvent extends RuntimeEvent {
  readonly type: 'workspace.created';
  readonly workspace: WorkspaceEntry;
}

export interface WorkspaceUpdatedEvent extends RuntimeEvent {
  readonly type: 'workspace.updated';
  readonly workspace: WorkspaceEntry;
}

export interface WorkspaceDeletedEvent extends RuntimeEvent {
  readonly type: 'workspace.deleted';
  readonly workspaceId: string;
  readonly root: string;
}

export interface WorkspaceTrustChangedEvent extends RuntimeEvent {
  readonly type: 'workspace.trust.changed';
  readonly root: string;
  readonly trusted: boolean;
}

export type WorkspacesEvent =
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | WorkspaceTrustChangedEvent;

export interface WorkspaceFsFace {
  readonly host: OsHost;
  readonly git: WorkspaceGitPort;
  browse(path?: string): Promise<FsBrowseResponse>;
  home(): Promise<FsHomeResponse>;
  probe(path: string): Promise<FsContentProbe>;
  read(path: string, n?: number, offset?: number): Promise<Uint8Array>;
  stat(path: string): Promise<HostFileStat>;
  mkdir(path: string): Promise<void>;
  view(roots: WorkspaceFsRoots): WorkspaceFsView;
}

export interface WorkspacesFace {
  readonly state: ShallowRef<WorkspacesState>;
  readonly fs: WorkspaceFsFace | undefined;
  list(): readonly WorkspaceEntry[];
  get(id: string): WorkspaceEntry | undefined;
  findByRoot(path: string): WorkspaceEntry | undefined;
  createOrTouch(root: string, name?: string): Promise<WorkspaceEntry>;
  openSession(root: string, input?: OpenSessionInput): Promise<SessionHandle>;
  update(id: string, patch: WorkspacePatch): Promise<WorkspaceEntry | undefined>;
  delete(id: string): Promise<void>;
  getTrust(id: string): boolean | undefined;
  trust(id: string): Promise<boolean | undefined>;
  untrust(id: string): Promise<boolean | undefined>;
  isTrusted(root: string): boolean;
  sessionCount(id: string): Promise<number>;
  addDir(id: string, path: string, persist?: boolean): Promise<AddDirResult | undefined>;
  additionalDirs(id: string): Promise<readonly string[]>;
}

export const WorkspaceRef = createFacadeToken<WorkspacesFace>('workspaces');

export interface CreateWorkspacesProps {
  readonly homeDir: string;
  readonly host?: OsHost;
  readonly now?: () => number;
  readonly defaultRoot?: string;
}

function createWorkspacesJournal(fs: OsFsPort | undefined, file: string): Journal<RecordEvent, number> {
  const memory: Entry<RecordEvent, number>[] = [];
  let seq = 0;
  return {
    read: async () => {
      if (fs === undefined) return memory;
      let text: string;
      try {
        text = await fs.readText(file);
      } catch {
        return [];
      }
      const entries: Entry<RecordEvent, number>[] = [];
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const event = JSON.parse(trimmed) as RecordEvent;
          if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
            continue;
          }
          entries.push(Object.freeze({ event, cursor: seq }));
          seq += 1;
        } catch {
        }
      }
      return entries;
    },
    append: async (event) => {
      if (fs !== undefined) {
        await fs.mkdir(dirname(file), { recursive: true });
        await fs.appendText(file, `${JSON.stringify(event)}\n`);
      }
      const entry: Entry<RecordEvent, number> = Object.freeze({ event, cursor: seq });
      seq += 1;
      if (fs === undefined) memory.push(entry);
      return entry;
    },
    close: () => Promise.resolve(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function createWorkspaces(props: CreateWorkspacesProps): FeatureSpec<WorkspacesEvent> {
  return createFeature<WorkspacesEvent>('workspaces', {
    app() {
      const fire = useFire();
      const app = useApp();
      const host = props.host;
      const now = props.now ?? Date.now;
      if (host !== undefined) {
        useReady(host.environment.ready);
      }
      const journal = createWorkspacesJournal(
        host?.fs,
        join(props.homeDir, 'workspaces', 'journal.jsonl'),
      );
      const storePromise = openStore({ journal, projection: workspacesProjection });
      useReady(storePromise.then(() => undefined));
      useCleanup(() => {
        void storePromise.then((store) => store.close()).catch(() => {});
      });
      const state = shallowRef<WorkspacesState>(workspacesProjection.initial());
      void storePromise.then((store) => {
        state.value = store.getState();
        store.subscribe((next) => {
          state.value = next;
        });
      });
      const dispatch = async (event: RecordEvent): Promise<void> => {
        const store = await storePromise;
        await store.dispatch(event);
      };
      const currentState = async (): Promise<WorkspacesState> => (await storePromise).getState();

      const ephemeralDirs = new Map<string, string[]>();

      const pathExists = async (path: string): Promise<boolean> => {
        if (host === undefined) return false;
        try {
          await host.fs.lstat(path);
          return true;
        } catch {
          return false;
        }
      };

      const findProjectRoot = async (workDir: string): Promise<string> => {
        const initial = normalize(workDir);
        let current = initial;
        while (true) {
          if (await pathExists(join(current, '.git'))) return current;
          const parent = dirname(current);
          if (parent === current) return initial;
          current = parent;
        }
      };

      const localTomlPath = (projectRoot: string): string =>
        join(projectRoot, '.kimi-code', 'local.toml');

      const readLocalToml = async (
        configPath: string,
      ): Promise<{ raw: Record<string, unknown>; additionalDirs: string[] }> => {
        let text: string | undefined;
        try {
          text = await host?.fs.readText(configPath);
        } catch {
          text = undefined;
        }
        if (text === undefined || text.trim().length === 0) {
          return { raw: {}, additionalDirs: [] };
        }
        let raw: unknown;
        try {
          raw = parseToml(text);
        } catch {
          throw new WorkspaceFsError('fs.config_invalid', `Invalid TOML in ${configPath}`, {
            path: configPath,
          });
        }
        if (!isPlainObject(raw)) {
          throw new WorkspaceFsError(
            'fs.config_invalid',
            `Invalid project local config in ${configPath}`,
            { path: configPath },
          );
        }
        const workspace = raw['workspace'];
        let dirs: unknown;
        if (workspace !== undefined) {
          if (!isPlainObject(workspace)) {
            throw new WorkspaceFsError('fs.config_invalid', 'workspace must be a table', {
              path: configPath,
            });
          }
          dirs = workspace['additional_dir'];
        }
        let additionalDirs: string[] = [];
        if (dirs !== undefined) {
          if (!Array.isArray(dirs) || dirs.some((dir) => typeof dir !== 'string')) {
            throw new WorkspaceFsError(
              'fs.config_invalid',
              'workspace.additional_dir must be an array of strings',
              { path: configPath },
            );
          }
          additionalDirs = dirs as string[];
        }
        return { raw: cloneRecord(raw), additionalDirs };
      };

      const expandHome = (value: string): string => {
        const osHomeDir = host?.environment.homeDir ?? props.homeDir;
        if (value === '~') return osHomeDir;
        if (value.startsWith('~/')) return join(osHomeDir, value.slice(2));
        return value;
      };

      const resolvePath = (baseDir: string, additionalDir: string): string => {
        const expanded = expandHome(additionalDir);
        return isAbsolute(expanded) ? normalize(expanded) : resolve(baseDir, expanded);
      };

      const hasSameAdditionalDir = (dirs: readonly string[], target: string): boolean => {
        const normalizedTarget = normalize(target);
        return dirs.some((dir) => normalize(dir) === normalizedTarget);
      };

      const resolveExistingDirs = (projectRoot: string, dirs: readonly string[]): string[] => {
        const resolvedDirs: string[] = [];
        for (const dir of dirs) {
          const trimmed = dir.trim();
          if (trimmed === '') continue;
          const resolvedDir = resolvePath(projectRoot, normalize(trimmed));
          if (hasSameAdditionalDir(resolvedDirs, resolvedDir)) continue;
          resolvedDirs.push(resolvedDir);
        }
        return resolvedDirs;
      };

      const readAdditionalDirs = async (
        workDir: string,
      ): Promise<{ projectRoot: string; configPath: string; additionalDirs: string[] }> => {
        const projectRoot = await findProjectRoot(workDir);
        const configPath = localTomlPath(projectRoot);
        const file = await readLocalToml(configPath);
        return {
          projectRoot,
          configPath,
          additionalDirs: resolveExistingDirs(projectRoot, file.additionalDirs),
        };
      };

      const appendAdditionalDir = async (
        workDir: string,
        additionalDir: string,
      ): Promise<{ projectRoot: string; configPath: string; additionalDirs: string[] }> => {
        const projectRoot = await findProjectRoot(workDir);
        const configPath = localTomlPath(projectRoot);
        const file = await readLocalToml(configPath);
        const fileExistingDirs = resolveExistingDirs(projectRoot, file.additionalDirs);
        if (hasSameAdditionalDir(fileExistingDirs, additionalDir)) {
          return { projectRoot, configPath, additionalDirs: fileExistingDirs };
        }
        const workspace = cloneRecord(file.raw['workspace']);
        workspace['additional_dir'] = [...fileExistingDirs, additionalDir];
        file.raw['workspace'] = workspace;
        if (host === undefined) {
          throw new WorkspaceFsError('fs.config_invalid', 'workspace fs is unavailable (no os host)');
        }
        await host.fs.mkdir(dirname(configPath), { recursive: true });
        await host.fs.writeText(configPath, `${stringifyToml(file.raw)}\n`);
        return {
          projectRoot,
          configPath,
          additionalDirs: [...fileExistingDirs, additionalDir],
        };
      };

      const mergedAdditionalDirs = (id: string, fileDirs: readonly string[]): readonly string[] => [
        ...new Set([...fileDirs, ...(ephemeralDirs.get(id) ?? [])]),
      ];

      const requireFs = (): OsHost => {
        if (host === undefined) {
          throw new WorkspaceFsError('fs.config_invalid', 'workspace fs is unavailable (no os host)');
        }
        return host;
      };

      const face: WorkspacesFace = {
        state,
        fs:
          host === undefined
            ? undefined
            : (() => {
                const fsHost = host;
                const browser = createHostFsBrowser(
                  fsHost.fs,
                  () => fsHost.environment.homeDir,
                  async () => dedupeWorkspacesByRoot(await currentState()).map((ws) => ws.root),
                );
                const git = createWorkspaceGit(fsHost);
                return {
                  host: fsHost,
                  git,
                  browse: browser.browse,
                  home: browser.home,
                  probe: browser.probe,
                  read: (path, n, offset) => fsHost.fs.readBytes(path, n, offset),
                  stat: (path) => fsHost.fs.stat(path),
                  mkdir: browser.mkdir,
                  view: (roots) => createWorkspaceFsView(fsHost.fs, roots, git),
                };
              })(),
        list: () => dedupeWorkspacesByRoot(state.value),
        get: (id) => getWorkspaceEntry(state.value, id),
        findByRoot: (path) => {
          const rootKey = workspaceRootKey(path);
          for (const workspace of state.value.workspaces.values()) {
            if (workspaceRootKey(workspace.root) === rootKey) return workspace;
          }
          return undefined;
        },
        createOrTouch: async (root, name) => {
          if (host !== undefined) {
            let statResult;
            try {
              statResult = await host.fs.stat(root);
            } catch (error) {
              const mapped = mapHostFsError(error, root);
              if (mapped instanceof WorkspaceFsError && mapped.code === 'fs.path_not_found') {
                throw new WorkspaceFsError(
                  'fs.path_not_found',
                  `workspace root ${root} does not exist`,
                  { path: root },
                );
              }
              throw mapped;
            }
            if (!statResult.isDirectory) {
              try {
                statResult = await host.fs.stat(await host.fs.realpath(root));
              } catch {
              }
            }
            if (!statResult.isDirectory) {
              throw new WorkspaceFsError(
                'fs.path_not_found',
                `workspace root ${root} is not a directory`,
                { path: root },
              );
            }
          }
          const before = await currentState();
          const id = encodeWorkDirKey(root);
          let existing = before.workspaces.get(id);
          if (existing === undefined) {
            const rootKey = workspaceRootKey(root);
            for (const entry of before.workspaces.values()) {
              if (workspaceRootKey(entry.root) === rootKey) {
                existing = entry;
                break;
              }
            }
          }
          const timestamp = now();
          if (existing !== undefined) {
            const workspace: WorkspaceEntry = { ...existing, lastOpenedAt: timestamp };
            await dispatch({ type: WORKSPACE_UPDATED, workspace });
            if (existing.id !== id && before.aliases.get(id) !== existing.id) {
              await dispatch({ type: WORKSPACE_ALIAS, aliasId: id, workspaceId: existing.id });
            }
            fire({ type: 'workspace.updated', workspace });
            return workspace;
          }
          const workspace: WorkspaceEntry = {
            id,
            root,
            name: name ?? basename(root),
            createdAt: timestamp,
            lastOpenedAt: timestamp,
          };
          await dispatch({ type: WORKSPACE_CREATED, workspace });
          fire({ type: 'workspace.created', workspace });
          return workspace;
        },
        openSession: async (root, input) => {
          const workspace = await face.createOrTouch(root);
          return app.open({
            ...input,
            metadata: withSessionWorkspace(input?.metadata, workspace.id),
          });
        },
        update: async (id, patch) => {
          const before = await currentState();
          const existing = getWorkspaceEntry(before, id);
          if (existing === undefined) return undefined;
          const updated: WorkspaceEntry = {
            ...existing,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
          };
          await dispatch({ type: WORKSPACE_UPDATED, workspace: updated });
          fire({ type: 'workspace.updated', workspace: updated });
          return updated;
        },
        delete: async (id) => {
          const before = await currentState();
          const entry = getWorkspaceEntry(before, id);
          let root = entry?.root;
          if (root === undefined) {
            for (const record of await app.space.list()) {
              const cwd = record.metadata?.['cwd'];
              if (typeof cwd === 'string' && encodeWorkDirKey(cwd) === id) {
                root = cwd;
                break;
              }
            }
          }
          if (root === undefined) {
            await dispatch({ type: WORKSPACE_DELETED, id, aliasIds: [id] });
            return;
          }
          const rootKey = workspaceRootKey(root);
          const aliasIds: string[] = [];
          const seen = new Set<string>();
          const addAlias = (alias: string): void => {
            if (seen.has(alias)) return;
            seen.add(alias);
            aliasIds.push(alias);
          };
          for (const workspace of before.workspaces.values()) {
            if (workspaceRootKey(workspace.root) === rootKey) addAlias(workspace.id);
          }
          for (const record of await app.space.list()) {
            const cwd = record.metadata?.['cwd'];
            if (typeof cwd === 'string' && workspaceRootKey(cwd) === rootKey) {
              addAlias(encodeWorkDirKey(cwd));
            }
          }
          await dispatch({ type: WORKSPACE_DELETED, id, root, aliasIds });
          ephemeralDirs.delete(id);
          fire({ type: 'workspace.deleted', workspaceId: id, root });
        },
        getTrust: (id) => {
          const entry = getWorkspaceEntry(state.value, id);
          if (entry === undefined) return undefined;
          return state.value.trust.has(workspaceTrustKey(entry.root));
        },
        trust: async (id) => {
          const before = await currentState();
          const entry = getWorkspaceEntry(before, id);
          if (entry === undefined) return undefined;
          const key = workspaceTrustKey(entry.root);
          if (before.trust.has(key)) return true;
          await dispatch({ type: WORKSPACE_TRUST_SET, key, trusted: true, trustedAt: now() });
          fire({ type: 'workspace.trust.changed', root: entry.root, trusted: true });
          return true;
        },
        untrust: async (id) => {
          const before = await currentState();
          const entry = getWorkspaceEntry(before, id);
          if (entry === undefined) return undefined;
          const key = workspaceTrustKey(entry.root);
          if (!before.trust.has(key)) return false;
          await dispatch({ type: WORKSPACE_TRUST_SET, key, trusted: false });
          fire({ type: 'workspace.trust.changed', root: entry.root, trusted: false });
          return false;
        },
        isTrusted: (root) => state.value.trust.has(workspaceTrustKey(root)),
        sessionCount: async (id) => {
          const before = await currentState();
          const candidates = new Set<string>([id]);
          for (const [aliasId, canonicalId] of before.aliases) {
            if (canonicalId === id) candidates.add(aliasId);
          }
          let count = 0;
          for (const record of await app.space.list()) {
            const bound = sessionWorkspaceId(record);
            if (bound !== undefined && candidates.has(bound)) {
              count += 1;
            }
          }
          return count;
        },
        addDir: async (id, input, persist = true) => {
          const fsHost = requireFs();
          const before = await currentState();
          const entry = getWorkspaceEntry(before, id);
          if (entry === undefined) return undefined;
          const trimmed = input.trim();
          const resolved = resolvePath(entry.root, trimmed);
          let statResult;
          try {
            statResult = await fsHost.fs.stat(resolved);
          } catch {
            throw new WorkspaceFsError('fs.path_not_found', `path ${input} does not exist`, {
              path: input,
            });
          }
          if (!statResult.isDirectory) {
            throw new WorkspaceFsError('fs.path_not_found', `path ${input} is not a directory`, {
              path: input,
            });
          }
          if (!persist) {
            const onDisk = await readAdditionalDirs(entry.root);
            const merged = [...new Set([...(ephemeralDirs.get(id) ?? []), resolved])];
            ephemeralDirs.set(id, merged);
            return {
              projectRoot: onDisk.projectRoot,
              configPath: onDisk.configPath,
              additionalDirs: [...new Set([...onDisk.additionalDirs, ...merged])],
              persisted: false,
            };
          }
          const persisted = await appendAdditionalDir(entry.root, resolved);
          return {
            projectRoot: persisted.projectRoot,
            configPath: persisted.configPath,
            additionalDirs: mergedAdditionalDirs(id, persisted.additionalDirs),
            persisted: true,
          };
        },
        additionalDirs: async (id) => {
          if (host === undefined) return [];
          const before = await currentState();
          const entry = getWorkspaceEntry(before, id);
          if (entry === undefined) return [];
          const onDisk = await readAdditionalDirs(entry.root);
          return mergedAdditionalDirs(id, onDisk.additionalDirs);
        },
      };
      useExpose(WorkspaceRef, face);
      if (props.defaultRoot !== undefined) {
        const defaultRoot = props.defaultRoot;
        useOnApp('session.created', (event) => {
          const sessionId = event['sessionId'];
          if (typeof sessionId !== 'string') return;
          void (async () => {
            const record = await app.space.get(sessionId);
            if (record === undefined || sessionWorkspaceId(record) !== undefined) return;
            const workspace = await face.createOrTouch(defaultRoot);
            await app.updateSession(sessionId, {
              metadata: withSessionWorkspace(record.metadata, workspace.id),
            });
          })().catch(() => {});
        });
      }
    },
  });
}
