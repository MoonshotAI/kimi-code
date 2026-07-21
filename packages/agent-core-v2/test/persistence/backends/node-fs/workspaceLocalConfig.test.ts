import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IWorkspaceLocalConfigService } from '#/app/workspaceLocalConfig/workspaceLocalConfig';
import { ErrorCodes } from '#/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { FileWorkspaceLocalConfigService } from '#/persistence/backends/node-fs/workspaceLocalConfigService';

describe('FileWorkspaceLocalConfigService — subagent bindings', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let root: string;

  beforeEach(async () => {
    disposables = new DisposableStore();
    root = await mkdtemp(join(tmpdir(), 'ws-local-binding-'));
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'packages', 'app'), { recursive: true });
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IBootstrapService, {
          _serviceBrand: undefined,
          homeDir: '/home/test',
          osHomeDir: '/users/test',
        } as IBootstrapService);
        reg.defineInstance(IHostFileSystem, new HostFileSystem());
        reg.define(IWorkspaceLocalConfigService, FileWorkspaceLocalConfigService);
      },
    });
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(root, { recursive: true, force: true });
  });

  function svc(): IWorkspaceLocalConfigService {
    return ix.get(IWorkspaceLocalConfigService);
  }

  function configPath(): string {
    return join(root, '.kimi-code', 'local.toml');
  }

  it('returns undefined when no binding is configured', async () => {
    await expect(svc().readSubagentBinding(join(root, 'packages', 'app'), 'coder')).resolves.toBeUndefined();
    await expect(svc().readSubagentSlotBinding(root, 'debater_a')).resolves.toBeUndefined();
  });

  it('writes and reads back a model/effort binding through the project root', async () => {
    const workDir = join(root, 'packages', 'app');

    const written = await svc().writeSubagentBinding(workDir, 'coder', {
      model: 'kimi-code/kimi-for-coding',
      thinkingEffort: 'high',
    });

    expect(written.configPath).toBe(configPath());
    await expect(svc().readSubagentBinding(workDir, 'coder')).resolves.toEqual({
      model: 'kimi-code/kimi-for-coding',
      thinkingEffort: 'high',
      inherit: undefined,
    });
    await expect(svc().readSubagentBinding(workDir, 'explore')).resolves.toBeUndefined();
    const text = await readFile(configPath(), 'utf-8');
    expect(text).toContain('[subagent.coder]');
    expect(text).toContain('model = "kimi-code/kimi-for-coding"');
    expect(text).toContain('thinking_effort = "high"');
  });

  it('records an explicit inherit choice', async () => {
    await svc().writeSubagentBinding(root, 'explore', { inherit: true });

    await expect(svc().readSubagentBinding(root, 'explore')).resolves.toEqual({
      model: undefined,
      thinkingEffort: undefined,
      inherit: true,
    });
  });

  it('preserves unrelated local.toml content and other type bindings', async () => {
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(
      configPath(),
      '[workspace]\nadditional_dir = ["shared"]\n\n[custom]\nfoo = "bar"\n',
      'utf-8',
    );

    await svc().writeSubagentBinding(root, 'explore', { model: 'example/gamma-model' });
    await svc().writeSubagentBinding(root, 'coder', { model: 'example/alpha-model' });

    const text = await readFile(configPath(), 'utf-8');
    expect(text).toContain('[workspace]');
    expect(text).toContain('"shared"');
    expect(text).toContain('[custom]');
    expect(text).toContain('foo = "bar"');
    expect(text).toContain('[subagent.explore]');
    expect(text).toContain('[subagent.coder]');
    await expect(svc().readSubagentBinding(root, 'explore')).resolves.toMatchObject({
      model: 'example/gamma-model',
    });
    await expect(svc().readSubagentBinding(root, 'coder')).resolves.toMatchObject({
      model: 'example/alpha-model',
    });
  });

  it('clears a binding and drops the emptied section table', async () => {
    await svc().writeSubagentBinding(root, 'coder', { model: 'example/alpha-model' });

    await svc().writeSubagentBinding(root, 'coder', undefined);

    await expect(svc().readSubagentBinding(root, 'coder')).resolves.toBeUndefined();
    const text = await readFile(configPath(), 'utf-8');
    expect(text).not.toContain('subagent');
  });

  it('writes and reads back a named slot binding independently of type bindings', async () => {
    const written = await svc().writeSubagentSlotBinding(root, 'debater_a', {
      model: 'example/beta-model',
      thinkingEffort: 'high',
    });

    expect(written.configPath).toBe(configPath());
    await expect(svc().readSubagentSlotBinding(root, 'debater_a')).resolves.toEqual({
      model: 'example/beta-model',
      thinkingEffort: 'high',
      inherit: undefined,
    });
    // Slot storage is independent from the type-binding table.
    await expect(svc().readSubagentBinding(root, 'debater_a')).resolves.toBeUndefined();
    const text = await readFile(configPath(), 'utf-8');
    expect(text).toContain('[subagent-slot.debater_a]');
    expect(text).toContain('model = "example/beta-model"');

    await svc().writeSubagentSlotBinding(root, 'debater_a', undefined);

    await expect(svc().readSubagentSlotBinding(root, 'debater_a')).resolves.toBeUndefined();
    expect(await readFile(configPath(), 'utf-8')).not.toContain('subagent-slot');
  });

  it('rejects wrongly-typed binding entries with CONFIG_INVALID', async () => {
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(configPath(), '[subagent.coder]\nmodel = 5\n', 'utf-8');

    await expect(svc().readSubagentBinding(root, 'coder')).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });
});
