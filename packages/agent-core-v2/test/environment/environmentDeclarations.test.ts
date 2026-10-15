import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { EnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclarationService';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { Emitter } from '#/_base/event';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import type { EnvironmentsSection, EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';

function fakeConfig(section: EnvironmentsSection | undefined): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => (domain === 'environments' ? section : undefined),
  } as unknown as IConfigService;
}

beforeEach(() => vi.stubEnv('KIMI_CODE_WATCH', 'false'));
afterEach(() => vi.unstubAllEnvs());

function projectSource(text?: string, initiallyTrusted = false) {
  let content = text;
  let trusted = initiallyTrusted;
  const changes = new Emitter<{ trusted: boolean }>();
  const fs = {
    readText: vi.fn(async () => {
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    }),
  } as unknown as IHostFileSystem;
  const trust = {
    ready: Promise.resolve(), isTrusted: () => trusted, onDidChange: changes.event,
  } as unknown as IWorkspaceTrust;
  return {
    fs, trust,
    setText: (text?: string) => { content = text; },
    setTrusted: (value: boolean) => { trusted = value; changes.fire({ trusted }); },
  };
}

function context(id: string): IWorkspaceContext {
  return { workspaceId: id, cwd: `/${id}`, source: 'local' } as IWorkspaceContext;
}

const PROJECT = 'default = "dev"\n[dev]\ntype = "ssh"\nhost = "dev.example.test"\ndefaultCwd = "/remote/project"\n';

describe('project environment declarations', () => {
  it('keeps untrusted declarations preview-only and requires trust for their default', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    expect((await service.catalog()).entries).toEqual([]);
    expect(await service.declarations('a')).toMatchObject({ entries: [], trustRequired: true });
    source.setTrusted(true);
    expect(await service.declarations('a')).toMatchObject({
      default: { environmentId: 'dev', cwd: '/remote/project', source: 'project' },
    });
    expect(service.isVisible('a', 'dev')).toBe(true);
    expect(service.isVisible('b', 'dev')).toBe(false);
    source.setTrusted(false);
    expect(service.isVisible('a', 'dev')).toBe(false);
    expect((await service.catalog()).entries).toEqual([]);
    attachment.dispose();
    service.dispose();
  });

  it('rejects conflicting launchers with both origins and never lets the registered fallback select the other target', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig({ dev: { type: 'ssh', host: 'user.example.test' } } as EnvironmentsSection), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    const result = await service.declarations('a');
    expect(result?.projectError?.message).toContain('/a/.kimi-code/environments.toml');
    expect(result?.projectError?.message).toContain('config.toml');
    expect(() => { service.assertAllowed('a', 'dev'); }).toThrow('conflicts');
    expect(() => { service.assertAllowed('b', 'dev'); }).not.toThrow();
    source.setText(PROJECT.replace('dev.example.test', 'user.example.test'));
    await service.declarations('a');
    expect(() => { service.assertAllowed('a', 'dev'); }).not.toThrow();
    attachment.dispose();
    service.dispose();
  });

  it('fails closed on invalid trusted config or missing project provenance while preserving dynamic bindings', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    await service.declarations('a');
    source.setText('broken = [');
    expect((await service.declarations('a'))?.projectError).toMatchObject({ code: 'config.invalid' });
    expect(() => { service.assertAllowed('a', 'dev', true); }).toThrow('Invalid environment declarations');
    expect(() => { service.assertAllowed('a', 'acp:example'); }).not.toThrow();
    source.setText();
    await service.declarations('a');
    expect(() => { service.assertAllowed('a', 'dev', true); }).toThrow('trusted declaration');
    attachment.dispose();
    service.dispose();
  });

  it('reloads again when an invalidation arrives during a coalesced read', async () => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    await service.declarations('a');
    let release!: () => void;
    let start!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { start = resolve; });
    vi.mocked(source.fs.readText).mockImplementationOnce(async () => { start(); await gate; return PROJECT; });
    const refresh = service.declarations('a');
    await started;
    source.setText(PROJECT.replace('dev.example.test', 'new.example.test'));
    source.setTrusted(true);
    release();
    expect((await refresh)?.entries[0]?.entry).toMatchObject({ host: 'new.example.test' });
    await service.whenReady('a');
    expect(service.isVisible('a', 'dev')).toBe(true);
    attachment.dispose();
    service.dispose();
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('does not lose an invalidation at singleflight settlement (microtask depth %s)', async (depth) => {
    const service = new EnvironmentDeclarationService(fakeConfig(undefined), { warn: vi.fn() } as never, new EnvironmentRegistry());
    const source = projectSource(PROJECT, true);
    const attachment = service.attachWorkspace(context('a'), source.fs, source.trust);
    await service.declarations('a');
    const changed: EnvironmentDeclarationSet[] = [];
    service.onDidChange((event) => { changed.push(event); });
    vi.mocked(source.fs.readText).mockImplementationOnce(async () => {
      const invalidate = (remaining: number): void => {
        queueMicrotask(() => {
          if (remaining > 1) invalidate(remaining - 1);
          else {
            source.setText(PROJECT.replace('dev.example.test', 'new.example.test'));
            source.setTrusted(true);
          }
        });
      };
      invalidate(depth);
      return PROJECT;
    });
    await service.declarations('a');
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    await service.whenReady('a');
    expect(changed.at(-1)?.entries[0]?.entry).toMatchObject({ host: 'new.example.test' });
    attachment.dispose();
    service.dispose();
  });
});
