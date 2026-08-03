import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/_base/di/scope';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ErrorCodes, Error2 } from '#/errors';
import {
  type HostDirEntry,
  type HostFileStat,
  IHostFileSystem,
} from '#/os/interface/hostFileSystem';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceCommandService } from '#/session/workspaceCommand/workspaceCommand';
import { SessionWorkspaceCommandService } from '#/session/workspaceCommand/workspaceCommandService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';

import { stubContextMemory, type StubContextMemory } from '../../agent/contextMemory/stubs';

const WORK_DIR = '/repo/work';
const EXTRA_DIR = `${WORK_DIR}/extra`;
const DIR_A = `${WORK_DIR}/a`;
const DIR_B = `${WORK_DIR}/b`;

class MemoryHostFs implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly danglingSymlinks = new Set<string>();
  readonly statErrors = new Map<string, NodeJS.ErrnoException>();
  readonly readErrors = new Map<string, NodeJS.ErrnoException>();
  readonly readsDuringPausedWrite: string[] = [];
  private pausedWrites = 0;
  private nextWritePause:
    | {
        readonly started: () => void;
        readonly release: Promise<void>;
      }
    | undefined;

  constructor(seedDirs: readonly string[] = []) {
    for (const d of seedDirs) this.dirs.add(d);
  }

  async readText(path: string): Promise<string> {
    if (this.pausedWrites > 0) this.readsDuringPausedWrite.push(path);
    const error = this.readErrors.get(path);
    if (error !== undefined) throw error;
    const text = this.files.get(path);
    if (text === undefined) throw enoent(path);
    return text;
  }

  async writeText(path: string, data: string): Promise<void> {
    const pause = this.nextWritePause;
    if (pause !== undefined) {
      this.nextWritePause = undefined;
      this.pausedWrites++;
      pause.started();
      try {
        await pause.release;
      } finally {
        this.pausedWrites--;
      }
    }
    this.files.set(path, data);
  }

  async appendText(path: string, data: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }

  pauseNextWrite(): { readonly started: Promise<void>; readonly release: () => void } {
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextWritePause = { started, release: releasePromise };
    return { started: startedPromise, release };
  }

  async readBytes(): Promise<Uint8Array> {
    throw new Error('not implemented');
  }

  async writeBytes(): Promise<void> {
    throw new Error('not implemented');
  }

  async *readLines(): AsyncGenerator<string> {
    yield* [];
    throw new Error('not implemented');
  }

  async createExclusive(): Promise<boolean> {
    throw new Error('not implemented');
  }

  async stat(path: string): Promise<HostFileStat> {
    const error = this.statErrors.get(path);
    if (error !== undefined) throw error;
    if (this.danglingSymlinks.has(path)) throw enoent(path);
    if (this.files.has(path)) {
      return { isFile: true, isDirectory: false, size: this.files.get(path)?.length ?? 0 };
    }
    if (this.dirs.has(path)) return { isFile: false, isDirectory: true, size: 0 };
    throw enoent(path);
  }

  async lstat(path: string): Promise<HostFileStat> {
    if (this.danglingSymlinks.has(path)) {
      return { isFile: false, isDirectory: false, isSymbolicLink: true, size: 0 };
    }
    return this.stat(path);
  }

  async readdir(): Promise<readonly HostDirEntry[]> {
    throw new Error('not implemented');
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.dirs.delete(path);
  }

  async realpath(path: string): Promise<string> {
    if (this.files.has(path) || this.dirs.has(path)) return path;
    throw enoent(path);
  }
}

function enoent(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

interface AgentsStub extends IAgentLifecycleService {
  readonly mainContext: StubContextMemory;
  setMain(present: boolean): void;
}

function agentsStub(): AgentsStub {
  const mainContext = stubContextMemory();
  let mainPresent = false;
  const created = new Emitter<IAgentScopeHandle>();

  const mainHandle: IAgentScopeHandle = {
    id: MAIN_AGENT_ID,
    kind: LifecycleScope.Agent,
    accessor: {
      get: <T>(id: ServiceIdentifier<T>): T => {
        if (id === IAgentContextMemoryService) return mainContext as unknown as T;
        throw new Error(`unexpected service on main handle: ${String(id)}`);
      },
    },
    dispose: () => {},
  };

  return {
    _serviceBrand: undefined,
    mainContext,
    onDidCreate: created.event,
    onDidDispose: () => ({ dispose: () => {} }),
    create: () => Promise.reject(new Error('not implemented')),
    fork: () => Promise.reject(new Error('not implemented')),
    get: (id) => (id === MAIN_AGENT_ID && mainPresent ? mainHandle : undefined),
    list: () => [],
    remove: () => Promise.resolve(),
    broadcastPermissionMode: () => {},
    setMain: (present) => {
      mainPresent = present;
      if (present) created.fire(mainHandle);
    },
  };
}

function bootstrapStub(): IBootstrapService {
  return {
    _serviceBrand: undefined,
    homeDir: '/home/test',
    osHomeDir: '/users/test',
  } as IBootstrapService;
}

function sessionContext(workDir = WORK_DIR): ISessionContext {
  return makeSessionContext({
    sessionId: 'ses',
    workspaceId: 'ws',
    sessionDir: '/tmp/sessions/ws/ses',
    sessionScope: 'sessions/ws/ses',
    cwd: workDir,
  });
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  readonly svc: ISessionWorkspaceCommandService;
  readonly fs: MemoryHostFs;
  readonly agents: AgentsStub;
  readonly workspace: ISessionWorkspaceContext;
}

describe('SessionWorkspaceCommandService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
  });

  function build(
    seedDirs: readonly string[],
    mainPresent: boolean,
    workDir = WORK_DIR,
    gitDir = `${workDir}/.git`,
  ): Harness {
    const fs = new MemoryHostFs([gitDir, workDir, ...seedDirs]);
    const agents = agentsStub();
    const ctx = sessionContext(workDir);

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, ctx);
        reg.define(ISessionWorkspaceContext, SessionWorkspaceContextService);
        reg.defineInstance(IBootstrapService, bootstrapStub());
        reg.defineInstance(IHostFileSystem, fs);
        reg.define(IProjectLocalConfigService, FileProjectLocalConfigService);
        reg.defineInstance(IAgentLifecycleService, agents);
        reg.define(ISessionWorkspaceCommandService, SessionWorkspaceCommandService);
      },
    });

    const workspace = ix.get(ISessionWorkspaceContext);
    const svc = ix.get(ISessionWorkspaceCommandService);
    agents.setMain(mainPresent);
    return { svc, fs, agents, workspace };
  }

  it('persists the directory and injects a local-command-stdout message when main exists', async () => {
    const { svc, fs, agents, workspace } = build([EXTRA_DIR], true);

    const result = await svc.addAdditionalDir({ path: 'extra', persist: true });

    expect(result.persisted).toBe(true);
    expect(result.configPath).toBe(`${WORK_DIR}/.kimi-code/local.toml`);
    expect(result.additionalDirs).toContain(EXTRA_DIR);
    expect(workspace.additionalDirs).toContain(EXTRA_DIR);

    const written = fs.files.get(`${WORK_DIR}/.kimi-code/local.toml`);
    expect(written).toContain('additional_dir');
    expect(written).toContain(EXTRA_DIR);

    expect(agents.mainContext.messages).toHaveLength(1);
    expect(agents.mainContext.messages[0]?.content).toEqual([
      {
        type: 'text',
        text: `<local-command-stdout>\nAdded workspace directory:\n  extra\n  Saved to:\n  ${WORK_DIR}/.kimi-code/local.toml\n</local-command-stdout>`,
      },
    ]);
    expect(agents.mainContext.messages[0]?.origin).toEqual({
      kind: 'injection',
      variant: 'local-command-stdout',
    });
  });

  it('does not persist and injects a session-only message when persist is false', async () => {
    const { svc, fs, agents, workspace } = build([EXTRA_DIR], true);

    const result = await svc.addAdditionalDir({ path: 'extra', persist: false });

    expect(result.persisted).toBe(false);
    expect(workspace.additionalDirs).toContain(EXTRA_DIR);
    expect(fs.files.has(`${WORK_DIR}/.kimi-code/local.toml`)).toBe(false);

    expect(agents.mainContext.messages).toHaveLength(1);
    expect(agents.mainContext.messages[0]?.content).toEqual([
      {
        type: 'text',
        text: '<local-command-stdout>\nAdded workspace directory:\n  extra\n  For this session only\n</local-command-stdout>',
      },
    ]);
  });

  it('queues the injection until the main agent is created', async () => {
    const { svc, agents } = build([EXTRA_DIR], false);

    await svc.addAdditionalDir({ path: 'extra', persist: true });
    expect(agents.mainContext.messages).toHaveLength(0);

    agents.setMain(true);

    expect(agents.mainContext.messages).toHaveLength(1);
    expect(agents.mainContext.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Added workspace directory:'),
    });
  });

  it('keeps the persisted config idempotent when the same dir is added twice', async () => {
    const { svc, fs } = build([EXTRA_DIR], true);

    await svc.addAdditionalDir({ path: 'extra', persist: true });
    await svc.addAdditionalDir({ path: 'extra', persist: true });

    const written = fs.files.get(`${WORK_DIR}/.kimi-code/local.toml`);
    expect(written).toBeDefined();
    const matches = written?.match(new RegExp(EXTRA_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    expect(matches).toHaveLength(1);
  });

  it('serializes concurrent persisted additions so local.toml keeps both directories', async () => {
    const { svc, fs, workspace } = build([DIR_A, DIR_B], true);
    const pause = fs.pauseNextWrite();

    const first = svc.addAdditionalDir({ path: 'a', persist: true });
    await pause.started;

    const second = svc.addAdditionalDir({ path: 'b', persist: true });
    await nextMacrotask();
    const overlappingReads = [...fs.readsDuringPausedWrite];

    pause.release();
    const [, secondResult] = await Promise.all([first, second]);

    expect(overlappingReads).toEqual([]);
    expect(secondResult.additionalDirs).toEqual([DIR_A, DIR_B]);
    expect(workspace.additionalDirs).toEqual([DIR_A, DIR_B]);

    const written = fs.files.get(`${WORK_DIR}/.kimi-code/local.toml`);
    expect(written).toContain(DIR_A);
    expect(written).toContain(DIR_B);
  });

  it('resolves caller-relative dirs against the session workDir when project root is above it', async () => {
    const projectRoot = '/repo/project';
    const workDir = `${projectRoot}/apps/foo`;
    const sharedDir = `${workDir}/shared`;
    const { svc, fs, workspace } = build([sharedDir], true, workDir, `${projectRoot}/.git`);

    const result = await svc.addAdditionalDir({ path: 'shared', persist: true });

    expect(result.projectRoot).toBe(projectRoot);
    expect(result.configPath).toBe(`${projectRoot}/.kimi-code/local.toml`);
    expect(result.additionalDirs).toEqual([sharedDir]);
    expect(workspace.additionalDirs).toEqual([sharedDir]);
    expect(fs.files.get(`${projectRoot}/.kimi-code/local.toml`)).toContain(sharedDir);
  });

  it('keeps a dangling .git symlink as the local project-root marker', async () => {
    const ancestorRoot = '/repo/project';
    const workDir = `${ancestorRoot}/apps/foo`;
    const sharedDir = `${workDir}/shared`;
    const { svc, fs } = build([sharedDir], true, workDir, `${ancestorRoot}/.git`);
    fs.danglingSymlinks.add(`${workDir}/.git`);

    const result = await svc.addAdditionalDir({ path: 'shared', persist: true });

    expect(result.projectRoot).toBe(workDir);
    expect(result.configPath).toBe(`${workDir}/.kimi-code/local.toml`);
    expect(fs.files.get(`${workDir}/.kimi-code/local.toml`)).toContain(sharedDir);
  });

  it('resolves session-only relative dirs against the session workDir when project root is above it', async () => {
    const projectRoot = '/repo/project';
    const workDir = `${projectRoot}/apps/foo`;
    const sharedDir = `${workDir}/shared`;
    const { svc, fs, workspace } = build([sharedDir], true, workDir, `${projectRoot}/.git`);

    const result = await svc.addAdditionalDir({ path: 'shared', persist: false });

    expect(result.projectRoot).toBe(projectRoot);
    expect(result.configPath).toBe(`${projectRoot}/.kimi-code/local.toml`);
    expect(result.additionalDirs).toEqual([sharedDir]);
    expect(workspace.additionalDirs).toEqual([sharedDir]);
    expect(fs.files.has(`${projectRoot}/.kimi-code/local.toml`)).toBe(false);
  });

  it('expands home-relative dirs against the OS home like v1', async () => {
    const homeDir = '/users/test/shared';
    const { svc, workspace } = build([homeDir], true);

    const result = await svc.addAdditionalDir({ path: '~/shared', persist: false });

    expect(result.additionalDirs).toEqual([homeDir]);
    expect(workspace.additionalDirs).toEqual([homeDir]);
  });

  it('treats project-root stat errors as absent git markers like v1', async () => {
    const projectRoot = '/repo';
    const { svc, fs } = build([EXTRA_DIR], true, WORK_DIR, `${projectRoot}/.git`);
    const error = new Error('EACCES: cannot stat .git') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    fs.statErrors.set(`${WORK_DIR}/.git`, error);

    const result = await svc.addAdditionalDir({ path: 'extra', persist: true });

    expect(result.projectRoot).toBe(projectRoot);
    expect(result.configPath).toBe(`${projectRoot}/.kimi-code/local.toml`);
  });

  it('rejects a relative path that does not resolve to an existing directory', async () => {
    const { svc } = build([], true);

    await expect(svc.addAdditionalDir({ path: 'missing', persist: true })).rejects.toSatisfy(
      (error) => error instanceof Error2 && error.code === ErrorCodes.CONFIG_INVALID,
    );
  });

  it('surfaces a config read IO failure as storage.io_failed', async () => {
    const { svc, fs } = build([EXTRA_DIR], true);
    const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    fs.readErrors.set(`${WORK_DIR}/.kimi-code/local.toml`, error);

    await expect(svc.addAdditionalDir({ path: 'extra', persist: true })).rejects.toMatchObject({
      code: 'storage.io_failed',
    });
  });

  it('surfaces invalid TOML in the config as storage.decode_failed', async () => {
    const { svc, fs } = build([EXTRA_DIR], true);
    fs.files.set(`${WORK_DIR}/.kimi-code/local.toml`, 'not [valid toml');

    await expect(svc.addAdditionalDir({ path: 'extra', persist: true })).rejects.toMatchObject({
      code: 'storage.decode_failed',
    });
  });
});
