import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import type { WatchChange } from '#human/utils/watch';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';
import { registerStateServices } from '../../state/stubs';

const watchFires = new Map<string, Emitter<WatchChange>>();
const watchCandidatesCalls: Array<{ root: string; candidates: readonly string[] }> = [];

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
    watchCandidates: (root: string, candidates: readonly string[]) => {
      watchCandidatesCalls.push({ root, candidates: [...candidates] });
      return watch(root);
    },
  };
});

describe('WorkspaceDirsService', () => {
  let workDir: string;
  let disposables: DisposableStore;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'kimi-workspace-dirs-'));
    disposables = new DisposableStore();
    watchFires.clear();
    watchCandidatesCalls.length = 0;
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(workDir, { recursive: true, force: true });
  });

  function fireWatch(path: string): void {
    for (const [root, emitter] of watchFires) {
      if (path === root || path.startsWith(`${root}/`)) {
        emitter.fire({ path, action: 'modified', kind: 'file' });
      }
    }
  }

  async function writeLocalToml(content: string): Promise<void> {
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(workDir, '.kimi-code', 'local.toml'), content, 'utf8');
  }

  function createService(): { service: IWorkspaceDirs; warnings: string[] } {
    const warnings: string[] = [];
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, { cwd: workDir });
        reg.defineInstance(
          IProjectLocalConfigService,
          new FileProjectLocalConfigService(stubBootstrap(), new HostFileSystem()),
        );
        reg.defineInstance(ILogService, {
          ...stubLog(),
          warn: (message: string) => {
            warnings.push(message);
          },
        });
        reg.define(IWorkspaceDirs, WorkspaceDirsService);
      },
    });
    return { service: ix.get(IWorkspaceDirs), warnings };
  }

  it('loads additional dirs from local.toml on ready and arms the watch', async () => {
    const extra = join(workDir, 'extra');
    await mkdir(extra, { recursive: true });
    await writeLocalToml('[workspace]\nadditional_dir = ["extra"]\n');

    const { service, warnings } = createService();
    await service.ready;

    expect(service.additionalDirs).toEqual([extra]);
    expect(warnings).toEqual([]);
    expect(watchCandidatesCalls).toEqual([
      { root: workDir, candidates: [join(workDir, '.kimi-code', 'local.toml')] },
    ]);
  });

  it('settles ready with only the valid entries when local.toml contains stale dirs', async () => {
    const alive = join(workDir, 'alive');
    await mkdir(alive, { recursive: true });
    await writeLocalToml('[workspace]\nadditional_dir = ["deleted-dir", "alive"]\n');

    const { service } = createService();
    await service.ready;

    expect(service.additionalDirs).toEqual([alive]);
  });

  it('settles ready with empty dirs and keeps the watch armed when local.toml is invalid', async () => {
    await writeLocalToml('[workspace\nadditional_dir = [');

    const { service, warnings } = createService();
    await service.ready;

    expect(service.additionalDirs).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('local.toml');
    expect(watchCandidatesCalls).toEqual([
      { root: workDir, candidates: [join(workDir, '.kimi-code', 'local.toml')] },
    ]);

    const extra = join(workDir, 'extra');
    await mkdir(extra, { recursive: true });
    await writeLocalToml('[workspace]\nadditional_dir = ["extra"]\n');
    fireWatch(join(workDir, '.kimi-code', 'local.toml'));

    await vi.waitFor(() => {
      expect(service.additionalDirs).toEqual([extra]);
    });
  });

  it('keeps the previous dirs and logs when a watched reload fails', async () => {
    const extra = join(workDir, 'extra');
    await mkdir(extra, { recursive: true });
    await writeLocalToml('[workspace]\nadditional_dir = ["extra"]\n');

    const { service, warnings } = createService();
    await service.ready;
    expect(service.additionalDirs).toEqual([extra]);

    await writeLocalToml('[workspace\nadditional_dir = [');
    fireWatch(join(workDir, '.kimi-code', 'local.toml'));

    await vi.waitFor(() => {
      expect(warnings).toHaveLength(1);
    });
    expect(warnings[0]).toContain('local.toml reload failed');
    expect(service.additionalDirs).toEqual([extra]);
  });
});
