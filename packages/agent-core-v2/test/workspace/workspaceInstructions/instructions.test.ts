/**
 * Scenario: workspace AGENTS.md instructions — build-time snapshot,
 * watch-driven refresh, and the `workspaceInstructions.current` state
 * registration.
 *
 * Exercises the real `WorkspaceInstructionsService` against real temp
 * instruction files with a manually-fired fs-watch stub. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceInstructions/instructions.test.ts`.
 */

import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  IHostFsWatchService,
  type HostFsChange,
  type IHostFsWatchHandle,
} from '#/os/interface/hostFsWatch';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import {
  WorkspaceInstructionsService,
  workspaceInstructionsCurrentKey,
} from '#/workspace/workspaceInstructions/workspaceInstructionsService';

import { stubLog } from '../../_base/log/stubs';
import { registerStateServices } from '../../state/stubs';

describe('WorkspaceInstructionsService', () => {
  let workDir: string;
  let osHomeDir: string;
  let brandHomeDir: string;
  let disposables: DisposableStore;
  let watchFires: Map<string, Emitter<HostFsChange>>;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'kimi-instructions-work-'));
    osHomeDir = mkdtempSync(join(tmpdir(), 'kimi-instructions-os-'));
    brandHomeDir = mkdtempSync(join(tmpdir(), 'kimi-instructions-brand-'));
    disposables = new DisposableStore();
    watchFires = new Map();
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all([
      rm(workDir, { recursive: true, force: true }),
      rm(osHomeDir, { recursive: true, force: true }),
      rm(brandHomeDir, { recursive: true, force: true }),
    ]);
  });

  function fsWatchStub(): IHostFsWatchService {
    return {
      _serviceBrand: undefined,
      watch: (path: string): IHostFsWatchHandle => {
        let emitter = watchFires.get(path);
        if (emitter === undefined) {
          emitter = new Emitter<HostFsChange>();
          watchFires.set(path, emitter);
        }
        return { ready: Promise.resolve(), onDidChange: emitter.event, dispose: () => {} };
      },
    };
  }

  function fireWatch(path: string): void {
    for (const [root, emitter] of watchFires) {
      if (path === root || path.startsWith(`${root}/`)) {
        emitter.fire({ path, action: 'modified', kind: 'file' });
      }
    }
  }

  function createService(): {
    service: IWorkspaceInstructionsService;
    states: IWorkspaceStateService;
  } {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, { cwd: workDir });
        reg.defineInstance(IHostFileSystem, new HostFileSystem());
        reg.definePartialInstance(IHostEnvironment, { homeDir: osHomeDir });
        reg.definePartialInstance(IBootstrapService, { homeDir: brandHomeDir });
        reg.defineInstance(IHostFsWatchService, fsWatchStub());
        reg.defineInstance(ILogService, stubLog());
        reg.define(IWorkspaceInstructionsService, WorkspaceInstructionsService);
      },
    });
    return { service: ix.get(IWorkspaceInstructionsService), states: ix.get(IWorkspaceStateService) };
  }

  it('loads the AGENTS.md snapshot at build and projects it through the session provider', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf8');
    await writeFile(join(brandHomeDir, 'AGENTS.md'), 'brand instructions', 'utf8');

    const { service } = createService();
    await service.ready;

    expect(service.snapshot.agentsMd).toContain('brand instructions');
    expect(service.snapshot.agentsMd).toContain('project instructions');
    const provider = service.sessionProvider();
    expect(provider.agentsMd).toBe(service.snapshot.agentsMd);
    expect(provider.agentsMdWarning).toBeUndefined();
  });

  it('refreshes the snapshot and fires onDidChange when a watched file changes', async () => {
    const file = join(workDir, 'AGENTS.md');
    await writeFile(file, 'old instructions', 'utf8');
    const { service } = createService();
    await service.ready;
    expect(service.snapshot.agentsMd).toContain('old instructions');

    const changed = new Promise<void>((resolvePromise) => {
      const d = service.onDidChange(() => {
        d.dispose();
        resolvePromise();
      });
    });
    await writeFile(file, 'new instructions', 'utf8');
    fireWatch(file);
    await changed;

    expect(service.snapshot.agentsMd).toContain('new instructions');
    expect(service.snapshot.agentsMd).not.toContain('old instructions');
  });

  it('picks up a newly created AGENTS.md through the watch', async () => {
    const { service } = createService();
    await service.ready;
    expect(service.snapshot.agentsMd).toBe('');

    const file = join(workDir, 'AGENTS.md');
    const changed = new Promise<void>((resolvePromise) => {
      const d = service.onDidChange(() => {
        d.dispose();
        resolvePromise();
      });
    });
    await writeFile(file, 'created later', 'utf8');
    fireWatch(file);
    await changed;

    expect(service.snapshot.agentsMd).toContain('created later');
  });

  it('does not fire when a reload produces identical content', async () => {
    const file = join(workDir, 'AGENTS.md');
    await writeFile(file, 'stable', 'utf8');
    const { service } = createService();
    await service.ready;

    let fired = 0;
    service.onDidChange(() => {
      fired += 1;
    });
    fireWatch(file);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

    expect(fired).toBe(0);
  });

  it('registers the snapshot into the workspace state container and tracks reloads', async () => {
    const file = join(workDir, 'AGENTS.md');
    await writeFile(file, 'state instructions', 'utf8');
    const { service, states } = createService();
    await service.ready;

    expect(states.get(workspaceInstructionsCurrentKey).agentsMd).toContain('state instructions');

    const changed = new Promise<void>((resolvePromise) => {
      const d = service.onDidChange(() => {
        d.dispose();
        resolvePromise();
      });
    });
    await writeFile(file, 'updated instructions', 'utf8');
    fireWatch(file);
    await changed;

    expect(states.get(workspaceInstructionsCurrentKey).agentsMd).toContain('updated instructions');
  });
});
