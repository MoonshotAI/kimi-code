import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  IWorkspaceTrust,
  type WorkspaceTrustChange,
} from '#/workspace/workspaceTrust/workspaceTrust';
import {
  TRUST_WORKSPACE_ENV,
  WorkspaceTrustService,
  workspaceTrustTrustedKey,
} from '#/workspace/workspaceTrust/workspaceTrustService';
import {
  deleteWorkspaceTrust,
  readWorkspaceTrust,
  writeWorkspaceTrust,
} from '#/workspace/workspaceTrust/trustRecord';
import {
  IWorkspaceTrustStore,
  WorkspaceTrustStore,
} from '#/workspace/workspaceTrust/workspaceTrustStore';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { registerStateServices } from '../../state/stubs';

describe('WorkspaceTrustService', () => {
  let homeDir: string;
  let cwd: string;
  let disposables: DisposableStore;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-workspace-trust-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-trust-cwd-'));
    disposables = new DisposableStore();
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(cwd, { recursive: true, force: true }),
    ]);
  });

  function createService(
    root: string,
    events?: WorkspaceTrustChange[],
    env: NodeJS.ProcessEnv = {},
    sharedStore?: IWorkspaceTrustStore,
  ): { service: IWorkspaceTrust; states: IWorkspaceStateService; trustStore: IWorkspaceTrustStore } {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, { cwd: root });
        reg.defineInstance(IBootstrapService, stubBootstrap(homeDir, env));
        reg.defineInstance(
          IAtomicDocumentStore,
          new JsonAtomicDocumentStore(new FileStorageService(homeDir)),
        );
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        if (sharedStore === undefined) {
          reg.define(IWorkspaceTrustStore, WorkspaceTrustStore);
        } else {
          reg.defineInstance(IWorkspaceTrustStore, sharedStore);
        }
        reg.define(IWorkspaceTrust, WorkspaceTrustService);
      },
    });
    const service = ix.get(IWorkspaceTrust);
    if (events !== undefined) {
      service.onDidChange((change) => events.push(change));
    }
    return {
      service,
      states: ix.get(IWorkspaceStateService),
      trustStore: ix.get(IWorkspaceTrustStore),
    };
  }

  it('defaults to untrusted when no marker exists', async () => {
    const { service } = createService(cwd);
    await service.ready;

    expect(service.isTrusted()).toBe(false);
    expect(await service.get()).toBe(false);
  });

  it('trusts the workspace when KIMI_CODE_TRUST_WORKSPACE is set', async () => {
    const { service } = createService(cwd, undefined, {
      [TRUST_WORKSPACE_ENV]: '1',
    });
    await service.ready;

    expect(service.isTrusted()).toBe(true);
    expect(await service.get()).toBe(true);
  });

  it('ignores KIMI_CODE_TRUST_WORKSPACE values that do not parse as true', async () => {
    const { service } = createService(cwd, undefined, {
      [TRUST_WORKSPACE_ENV]: '0',
    });
    await service.ready;

    expect(service.isTrusted()).toBe(false);
    expect(await service.get()).toBe(false);
  });

  it('keeps persistence semantics under KIMI_CODE_TRUST_WORKSPACE', async () => {
    const events: WorkspaceTrustChange[] = [];
    const { service, states } = createService(cwd, events, {
      [TRUST_WORKSPACE_ENV]: '1',
    });
    await service.ready;

    await service.trust();
    expect(states.get(workspaceTrustTrustedKey)).toBe(true);

    await service.untrust();
    expect(states.get(workspaceTrustTrustedKey)).toBe(false);
    expect(service.isTrusted()).toBe(true);
    expect(events).toEqual([{ trusted: true }, { trusted: false }]);
  });

  it('trust() flips the state, fires once, and stays idempotent', async () => {
    const events: WorkspaceTrustChange[] = [];
    const { service } = createService(cwd, events);
    await service.ready;

    await service.trust();
    await service.trust();

    expect(service.isTrusted()).toBe(true);
    expect(await service.get()).toBe(true);
    expect(events).toEqual([{ trusted: true }]);
  });

  it('untrust() revokes the state and both directions stay idempotent', async () => {
    const events: WorkspaceTrustChange[] = [];
    const { service } = createService(cwd, events);
    await service.ready;

    await service.untrust();
    await service.trust();
    await service.untrust();
    await service.untrust();

    expect(service.isTrusted()).toBe(false);
    expect(events).toEqual([{ trusted: true }, { trusted: false }]);
  });

  it('keeps the marker across a restart', async () => {
    const { service: first } = createService(cwd);
    await first.ready;
    await first.trust();

    const { service: second } = createService(cwd);
    await second.ready;

    expect(second.isTrusted()).toBe(true);
  });

  it('migrates a legacy Windows trust marker to the canonical key', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const root = 'C:\\Users\\Foo\\Repo';
    const record = { root, trustedAt: 1 };
    await docs.set('workspace-trust', encodeWorkDirKey(root), record);

    expect(await readWorkspaceTrust(docs, root)).toBe(true);
    await expect(
      docs.get('workspace-trust', encodeWorkDirKey('c:/users/foo/repo')),
    ).resolves.toEqual(record);
  });

  it('shares one trust key across UNC and drive-letter spelling variants', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    await writeWorkspaceTrust(docs, '//server/share/repo', 1);
    expect(await readWorkspaceTrust(docs, '\\\\SERVER\\SHARE\\REPO')).toBe(true);
    expect(await readWorkspaceTrust(docs, '//Server/Share/Repo')).toBe(true);

    await writeWorkspaceTrust(docs, 'C:\\Users\\Foo\\Repo', 2);
    expect(await readWorkspaceTrust(docs, 'c:/users/foo/repo')).toBe(true);
  });

  it('deletes both canonical and legacy trust markers', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const root = 'C:\\Users\\Foo\\Repo';
    const legacyKey = encodeWorkDirKey(root);
    await docs.set('workspace-trust', legacyKey, { root, trustedAt: 1 });
    await writeWorkspaceTrust(docs, root, 2);

    await deleteWorkspaceTrust(docs, root);

    await expect(docs.get('workspace-trust', legacyKey)).resolves.toBeUndefined();
    await expect(readWorkspaceTrust(docs, root)).resolves.toBe(false);
  });

  it('propagates storage failures instead of reporting an untrusted workspace', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const failure = new Error('trust storage unavailable');
    const read = docs.get.bind(docs);
    docs.get = async () => {
      throw failure;
    };

    await expect(readWorkspaceTrust(docs, cwd)).rejects.toBe(failure);

    docs.get = read;
    await expect(readWorkspaceTrust(docs, cwd)).resolves.toBe(false);
  });

  it('retries failed initialization for both the shared entry and workspace service', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const failure = new Error('trust storage temporarily unavailable');
    const read = docs.get.bind(docs);
    let unavailable = true;
    docs.get = async <T>(scope: string, key: string): Promise<T | undefined> => {
      if (unavailable) throw failure;
      return read<T>(scope, key);
    };
    const trustStore = disposables.add(new WorkspaceTrustStore(
      docs,
      noopTelemetryService,
      stubBootstrap(homeDir),
    ));
    const entry = trustStore.forRoot(cwd);

    await expect(entry.get()).rejects.toBe(failure);

    const { service } = createService(cwd, undefined, {}, trustStore);
    await expect(service.ready).rejects.toBe(failure);
    unavailable = false;

    await service.ready;
    await expect(service.get()).resolves.toBe(false);
    await service.trust();
    await expect(entry.get()).resolves.toBe(true);
  });

  it('emits one recovery change when initialization discovers an existing marker', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    await writeWorkspaceTrust(docs, cwd, 1);
    const failure = new Error('trust storage temporarily unavailable');
    const read = docs.get.bind(docs);
    let unavailable = true;
    docs.get = async <T>(scope: string, key: string): Promise<T | undefined> => {
      if (unavailable) throw failure;
      return read<T>(scope, key);
    };
    const store = disposables.add(new WorkspaceTrustStore(
      docs,
      noopTelemetryService,
      stubBootstrap(homeDir),
    ));
    const entry = store.forRoot(cwd);
    const events: WorkspaceTrustChange[] = [];
    entry.onDidChange((change) => events.push(change));

    await expect(entry.get()).rejects.toBe(failure);
    unavailable = false;
    await expect(entry.get()).resolves.toBe(true);
    await entry.trust();

    expect(events).toEqual([{ trusted: true }]);
  });

  it('skips a corrupt legacy record but propagates legacy storage access failures', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const root = 'C:\\Users\\Foo\\Repo';
    await docs.set('workspace-trust', encodeWorkDirKey(root), { root, trustedAt: 1 });
    await writeFile(join(homeDir, 'workspace-trust', 'corrupt-record'), '{', 'utf8');

    await expect(readWorkspaceTrust(docs, 'c:/users/foo/repo')).resolves.toBe(true);
    await deleteWorkspaceTrust(docs, root);

    const failure = new Error('legacy trust record is inaccessible');
    const read = docs.get.bind(docs);
    docs.get = async <T>(scope: string, key: string): Promise<T | undefined> => {
      if (key === 'inaccessible-record') throw failure;
      return read<T>(scope, key);
    };
    await writeFile(join(homeDir, 'workspace-trust', 'inaccessible-record'), '{}', 'utf8');

    await expect(readWorkspaceTrust(docs, root)).rejects.toBe(failure);
  });

  it('tracks different roots independently', async () => {
    const other = mkdtempSync(join(tmpdir(), 'kimi-workspace-trust-other-'));
    try {
      const { service: first } = createService(cwd);
      await first.ready;
      await first.trust();

      const { service: second } = createService(other);
      await second.ready;

      expect(second.isTrusted()).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('registers the trusted flag into the workspace state container', async () => {
    const { service, states } = createService(cwd);
    await service.ready;

    expect(states.has(workspaceTrustTrustedKey)).toBe(true);
    expect(states.get(workspaceTrustTrustedKey)).toBe(false);

    const seen: boolean[] = [];
    states.onDidChange(workspaceTrustTrustedKey)((value) => seen.push(value));
    await service.trust();
    await service.untrust();

    expect(seen).toEqual([true, false]);
    expect(states.get(workspaceTrustTrustedKey)).toBe(false);
    expect(states.snapshot()['workspaceTrust.trusted']).toBe(false);
  });

  it('shares trust changes with every service using the same store', async () => {
    const firstEvents: WorkspaceTrustChange[] = [];
    const secondEvents: WorkspaceTrustChange[] = [];
    const first = createService(cwd, firstEvents);
    const second = createService(cwd, secondEvents, {}, first.trustStore);
    await Promise.all([first.service.ready, second.service.ready]);

    await first.service.trust();
    expect(second.service.isTrusted()).toBe(true);
    expect(second.states.get(workspaceTrustTrustedKey)).toBe(true);

    await second.service.untrust();
    expect(first.service.isTrusted()).toBe(false);
    expect(first.states.get(workspaceTrustTrustedKey)).toBe(false);
    expect(firstEvents).toEqual([{ trusted: true }, { trusted: false }]);
    expect(secondEvents).toEqual([{ trusted: true }, { trusted: false }]);
  });

  it('reuses one store entry for canonical root variants', () => {
    const { trustStore } = createService(cwd);
    const entry = trustStore.forRoot('C:\\Users\\Foo\\Repo');

    expect(trustStore.forRoot('c:/users/foo/repo')).toBe(entry);
    expect(trustStore.forRoot('C:\\Users\\Foo\\Other')).not.toBe(entry);
  });

  it('reads and clears legacy markers from non-initial root spellings', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const firstRoot = 'C:\\Users\\Foo\\Repo';
    const otherRoot = 'C:\\users\\foo\\repo';
    const thirdRoot = 'C:\\USERS\\Foo\\Repo';
    const legacyKey = encodeWorkDirKey(otherRoot);
    const thirdLegacyKey = encodeWorkDirKey(thirdRoot);
    await docs.set('workspace-trust', legacyKey, { root: otherRoot, trustedAt: 1 });
    await docs.set('workspace-trust', thirdLegacyKey, { root: thirdRoot, trustedAt: 2 });
    await docs.set('workspace-trust', 'null-record', null);
    await writeFile(
      join(homeDir, 'workspace-trust', `${legacyKey}.tmp.${process.pid}.deadbeef`),
      '{',
      'utf8',
    );
    const store = disposables.add(new WorkspaceTrustStore(
      docs,
      noopTelemetryService,
      stubBootstrap(homeDir),
    ));
    const entry = store.forRoot(firstRoot);

    await entry.ready;
    expect(entry.isTrusted()).toBe(true);

    await entry.untrust();
    expect(await docs.get('workspace-trust', legacyKey)).toBeUndefined();
    expect(await docs.get('workspace-trust', thirdLegacyKey)).toBeUndefined();
    expect(await readWorkspaceTrust(docs, otherRoot)).toBe(false);
  });

  it('serializes mutations that arrive during initialization', async () => {
    const docs = new JsonAtomicDocumentStore(new FileStorageService(homeDir));
    const read = docs.get.bind(docs);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    docs.get = async <T>(scope: string, key: string): Promise<T | undefined> => {
      await blocked;
      return read<T>(scope, key);
    };
    const store = disposables.add(new WorkspaceTrustStore(
      docs,
      noopTelemetryService,
      stubBootstrap(homeDir),
    ));
    const entry = store.forRoot(cwd);
    const events: WorkspaceTrustChange[] = [];
    entry.onDidChange((change) => events.push(change));

    const trusting = entry.trust();
    const untrusting = entry.untrust();
    release();
    await Promise.all([trusting, untrusting]);

    expect(await entry.get()).toBe(false);
    expect(events).toEqual([{ trusted: true }, { trusted: false }]);
  });

  it('tracks change telemetry once per effective mutation', async () => {
    const changes: unknown[] = [];
    const telemetry: ITelemetryService = {
      ...noopTelemetryService,
      track2(event, properties) {
        if (event === 'workspace_trust_changed') changes.push(properties);
      },
    };
    const store = disposables.add(new WorkspaceTrustStore(
      new JsonAtomicDocumentStore(new FileStorageService(homeDir)),
      telemetry,
      stubBootstrap(homeDir),
    ));
    const entry = store.forRoot(cwd);

    await entry.trust();
    await entry.trust();
    await entry.untrust();
    await entry.untrust();

    expect(changes).toEqual([{ trusted: true }, { trusted: false }]);
  });
});
