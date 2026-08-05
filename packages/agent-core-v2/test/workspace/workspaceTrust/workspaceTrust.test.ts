/**
 * Scenario: workspace trust — explicit trust/untrust flips persisted outside
 * the workspace, idempotency and the change event, per-root independence,
 * marker survival across a restart, and the `workspaceTrust.trusted` state
 * registration.
 *
 * Exercises the real `WorkspaceTrustService` against the real node-fs
 * `JsonAtomicDocumentStore` over a temp home. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceTrust/workspaceTrust.test.ts`.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  IWorkspaceTrust,
  type WorkspaceTrustChange,
} from '#/workspace/workspaceTrust/workspaceTrust';
import {
  WorkspaceTrustService,
  workspaceTrustTrustedKey,
} from '#/workspace/workspaceTrust/workspaceTrustService';

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
  ): { service: IWorkspaceTrust; states: IWorkspaceStateService } {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, { cwd: root });
        reg.defineInstance(
          IAtomicDocumentStore,
          new JsonAtomicDocumentStore(new FileStorageService(homeDir)),
        );
        reg.define(IWorkspaceTrust, WorkspaceTrustService);
      },
    });
    const service = ix.get(IWorkspaceTrust);
    if (events !== undefined) {
      service.onDidChange((change) => events.push(change));
    }
    return { service, states: ix.get(IWorkspaceStateService) };
  }

  it('defaults to untrusted when no marker exists', async () => {
    const { service } = createService(cwd);
    await service.ready;

    expect(service.isTrusted()).toBe(false);
    expect(await service.get()).toBe(false);
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
});
