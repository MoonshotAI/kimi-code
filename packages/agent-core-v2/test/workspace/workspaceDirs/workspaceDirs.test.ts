import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import {
  IWorkspaceTrust,
  type WorkspaceTrustChange,
} from '#/workspace/workspaceTrust/workspaceTrust';
import type { WatchChange } from '#human/utils/watch';

import { stubLog } from '../../_base/log/stubs';
import { registerStateServices } from '../../state/stubs';

const watchFires = new Map<string, Emitter<WatchChange>>();

vi.mock('#human/utils/watch', () => {
  const watch = (path: string) => {
    let emitter = watchFires.get(path);
    if (emitter === undefined) {
      emitter = new Emitter<WatchChange>();
      watchFires.set(path, emitter);
    }
    return { ready: Promise.resolve(), onDidChange: emitter.event, dispose: () => {} };
  };
  return {
    watch,
    watchCandidates: (root: string) => watch(root),
  };
});

describe('WorkspaceDirsService trust gating', () => {
  let cwd: string;
  let homeDir: string;
  let extraDir: string;
  let disposables: DisposableStore;
  let trusted: boolean;
  let trustFlips: Emitter<WorkspaceTrustChange>;
  let changes: number;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-dirs-cwd-'));
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-workspace-dirs-home-'));
    extraDir = mkdtempSync(join(tmpdir(), 'kimi-workspace-dirs-extra-'));
    disposables = new DisposableStore();
    watchFires.clear();
    trusted = true;
    trustFlips = new Emitter<WorkspaceTrustChange>();
    changes = 0;
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all(
      [cwd, homeDir, extraDir].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function createService(): IWorkspaceDirs {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, { cwd });
        reg.defineInstance(
          IProjectLocalConfigService,
          new FileProjectLocalConfigService(
            { _serviceBrand: undefined, osHomeDir: homeDir } as IBootstrapService,
            new HostFileSystem(),
          ),
        );
        reg.defineInstance(ILogService, stubLog());
        reg.definePartialInstance(IWorkspaceTrust, {
          ready: Promise.resolve(),
          isTrusted: () => trusted,
          onDidChange: trustFlips.event,
        });
        reg.define(IWorkspaceDirs, WorkspaceDirsService);
      },
    });
    const service = ix.get(IWorkspaceDirs);
    service.onDidChange(() => {
      changes += 1;
    });
    return service;
  }

  async function writeLocalToml(additionalDirs: readonly string[]): Promise<string> {
    const dir = join(cwd, '.kimi-code');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'local.toml');
    const entries = additionalDirs.map((dir) => `"${dir}"`).join(', ');
    await writeFile(file, `[workspace]\nadditional_dir = [${entries}]\n`, 'utf8');
    return file;
  }

  it('loads local.toml additional dirs when the workspace is trusted', async () => {
    await writeLocalToml([extraDir]);

    const service = createService();
    await service.ready;

    expect(service.additionalDirs).toEqual([extraDir]);
  });

  it('ignores local.toml additional dirs while the workspace is untrusted', async () => {
    await writeLocalToml([extraDir]);
    trusted = false;

    const service = createService();
    await service.ready;

    expect(service.additionalDirs).toEqual([]);
  });

  it('loads the additional dirs when the workspace becomes trusted', async () => {
    await writeLocalToml([extraDir]);
    trusted = false;
    const service = createService();
    await service.ready;
    expect(service.additionalDirs).toEqual([]);

    trusted = true;
    trustFlips.fire({ trusted: true });

    await vi.waitFor(
      () => {
        expect(service.additionalDirs).toEqual([extraDir]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(changes).toBe(1);
  }, 20000);

  it('clears the additional dirs when the workspace loses trust', async () => {
    await writeLocalToml([extraDir]);
    const service = createService();
    await service.ready;
    expect(service.additionalDirs).toEqual([extraDir]);

    trusted = false;
    trustFlips.fire({ trusted: false });

    expect(service.additionalDirs).toEqual([]);
  }, 20000);

  it('ignores watched local.toml changes while the workspace is untrusted', async () => {
    trusted = false;
    const service = createService();
    await service.ready;

    const file = await writeLocalToml([extraDir]);
    watchFires.get(cwd)?.fire({ path: file, action: 'modified', kind: 'file' });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(service.additionalDirs).toEqual([]);
    expect(changes).toBe(0);
  }, 20000);

  it('persists the explicit dir but loads only it while the workspace is untrusted', async () => {
    const plantedDir = join(homeDir, 'planted');
    await mkdir(plantedDir, { recursive: true });
    await writeLocalToml([plantedDir]);
    trusted = false;
    const service = createService();
    await service.ready;
    expect(service.additionalDirs).toEqual([]);

    const result = await service.addDir({ path: extraDir });

    expect(result.persisted).toBe(true);
    expect(result.additionalDirs).toEqual([extraDir]);
    expect(service.additionalDirs).toEqual([extraDir]);
    const onDisk = await readFile(join(cwd, '.kimi-code', 'local.toml'), 'utf8');
    expect(onDisk).toContain(plantedDir);
    expect(onDisk).toContain(extraDir);
  });

  it('keeps the explicitly added dir after a watched reload while untrusted', async () => {
    trusted = false;
    const service = createService();
    await service.ready;
    await service.addDir({ path: extraDir });
    expect(service.additionalDirs).toEqual([extraDir]);

    const file = join(cwd, '.kimi-code', 'local.toml');
    watchFires.get(cwd)?.fire({ path: file, action: 'modified', kind: 'file' });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(service.additionalDirs).toEqual([extraDir]);
  }, 20000);

  it('loads every persisted dir after add-dir when the workspace is trusted', async () => {
    const plantedDir = join(homeDir, 'planted');
    await mkdir(plantedDir, { recursive: true });
    await writeLocalToml([plantedDir]);
    const service = createService();
    await service.ready;
    expect(service.additionalDirs).toEqual([plantedDir]);

    const result = await service.addDir({ path: extraDir });

    expect(result.persisted).toBe(true);
    expect(result.additionalDirs).toEqual([plantedDir, extraDir]);
    expect(service.additionalDirs).toEqual([plantedDir, extraDir]);
  });
});
