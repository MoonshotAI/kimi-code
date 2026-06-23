import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Emitter } from '../../../src';
import { IEnvironmentService } from '../../../src/services/environment/environment';
import { IEventService } from '#/event';
import { ILogService } from '../../../src/services/logger/logger';
import { RECENT_ROOTS_LIMIT } from '../../../src/services/workspace/workspaceFs';
import {
  WorkspaceNotFoundError,
} from '../../../src/services/workspace/workspaceRegistry';
import { WorkspaceFsService } from '../../../src/services/workspace/workspaceFsService';
import { WorkspaceRegistryService } from '../../../src/services/workspace/workspaceRegistryService';
import { WorkspaceService } from '../../../src/services/workspace/workspaceService';

import type { Event as ProtocolEvent } from '@moonshot-ai/protocol';

class FakeLogService implements ILogService {
  readonly _serviceBrand: undefined;
  info(): void {}
  warn(): void {}
  error(): void {}
  debug(): void {}
  child(): ILogService {
    return this;
  }
}

class FakeEventService implements IEventService {
  readonly _serviceBrand: undefined;
  private readonly emitter = new Emitter<ProtocolEvent>();
  readonly onDidPublish = this.emitter.event;
  publish(event: ProtocolEvent): void {
    this.emitter.fire(event);
  }
}

function makeEnv(homeDir: string): IEnvironmentService {
  return {
    _serviceBrand: undefined,
    homeDir,
    configPath: join(homeDir, 'config.toml'),
  };
}

describe('WorkspaceService (M1.6 facade)', () => {
  let tmpHome: string;
  let root: string;
  let service: WorkspaceService;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(os.tmpdir(), 'kimi-ws-svc-'));
    root = join(tmpHome, 'ws-root');
    mkdirSync(root, { recursive: true });

    const registry = new WorkspaceRegistryService(
      makeEnv(tmpHome),
      new FakeLogService(),
      new FakeEventService(),
    );
    const fs = new WorkspaceFsService(registry);
    service = new WorkspaceService(registry, fs);
  });

  afterEach(() => {
    service.dispose();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('register (createOrTouch) then get returns the workspace', async () => {
    const created = await service.createOrTouch(root, 'my-ws');
    expect(created.name).toBe('my-ws');
    expect(created.root).toBe(realpathSync(root));

    const fetched = await service.get(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe('my-ws');
    expect(fetched.root).toBe(created.root);
  });

  it('resolveRoot returns the workDir for a workspace_id', async () => {
    const created = await service.createOrTouch(root);
    const resolved = await service.resolveRoot(created.id);
    expect(resolved).toBe(realpathSync(root));
  });

  it('list returns registered workspaces', async () => {
    const created = await service.createOrTouch(root);
    const all = await service.list();
    expect(all.map((w) => w.id)).toContain(created.id);
    expect(all).toHaveLength(1);
  });

  it('browse returns the fs browse response (delegate)', async () => {
    mkdirSync(join(root, 'child-dir'));
    const response = await service.browse(root);
    expect(response.path).toBe(realpathSync(root));
    const child = response.entries.find((e) => e.name === 'child-dir');
    expect(child).toBeDefined();
    expect(child?.is_dir).toBe(true);
  });

  it('home delegates to the fs service and surfaces recent roots', async () => {
    await service.createOrTouch(root);
    const response = await service.home();
    expect(response.home).toBe(os.homedir());
    expect(response.recent_roots).toContain(realpathSync(root));
  });

  it('listRecent surfaces the registry recency view (derived, no separate store)', async () => {
    const created = await service.createOrTouch(root);
    const recent = await service.listRecent();
    expect(recent.length).toBeLessThanOrEqual(RECENT_ROOTS_LIMIT);
    expect(recent.map((w) => w.id)).toContain(created.id);
  });

  it('delete removes the workspace', async () => {
    const created = await service.createOrTouch(root);
    await service.delete(created.id);
    await expect(service.get(created.id)).rejects.toThrow(WorkspaceNotFoundError);
  });
});
