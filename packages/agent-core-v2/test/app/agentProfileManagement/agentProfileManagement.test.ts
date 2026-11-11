import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseFrontmatter } from '#/_base/text/frontmatter';
import type { ILogService } from '#/_base/log/log';
import type { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { UserAgentProfileManagementService } from '#/app/agentProfileManagement/userAgentProfileManagementService';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

import { stubBootstrap } from '../bootstrap/stubs';

const BUILTIN_NAMES = new Set(['agent', 'coder', 'explore', 'plan']);

describe('UserAgentProfileManagementService', () => {
  let root: string;
  let home: string;
  let osHome: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-profile-management-'));
    home = join(root, 'kimi-home');
    osHome = join(root, 'os-home');
    await Promise.all([mkdir(home, { recursive: true }), mkdir(osHome, { recursive: true })]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeService(reload: () => Promise<void> = async () => {}): UserAgentProfileManagementService {
    const builtin = {
      get: (name: string) => BUILTIN_NAMES.has(name) ? { name } : undefined,
    } as unknown as IBuiltinAgentProfileLoader;
    const workspaces = {
      list: () => [{ program: { reload } }],
    } as unknown as IWorkspaceInstanceManager;
    const log = {
      warn: () => {},
      error: () => {},
    } as unknown as ILogService;
    return new UserAgentProfileManagementService(
      stubBootstrap(home, {}, {}, osHome),
      new HostFileSystem(),
      builtin,
      workspaces,
      log,
    );
  }

  it('creates the default root only on first create', async () => {
    const service = makeService();
    const empty = await service.list();
    expect(empty.root).toBe(join(home, 'agents'));
    expect(empty.agents).toEqual([]);

    const result = await service.create({
      name: 'code-reviewer',
      description: 'Review code changes',
      prompt: 'Review the diff.',
    });

    expect(result.refreshError).toBeUndefined();
    expect(result.agent.name).toBe('code-reviewer');
    const text = await readFile(join(home, 'agents', 'code-reviewer.md'), 'utf8');
    const parsed = parseFrontmatter(text);
    expect(parsed.data).toEqual({ name: 'code-reviewer', description: 'Review code changes' });
    expect(parsed.body.trim()).toBe('Review the diff.');
    expect((await service.list().then((list) => list.agents))).toHaveLength(1);
  });

  it('uses an existing generic user root', async () => {
    const generic = join(osHome, '.agents', 'agents');
    await mkdir(generic, { recursive: true });
    const service = makeService();

    await service.create({ name: 'docs-writer', description: 'Write docs', prompt: 'Write docs.' });

    expect(await realpath(generic)).toBe((await service.list()).root);
    expect(await readFile(join(generic, 'docs-writer.md'), 'utf8')).toContain('name: docs-writer');
  });

  it('preserves unexposed frontmatter fields on update', async () => {
    const dir = join(home, 'agents', 'nested');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'reviewer.md');
    await writeFile(path, `---\nname: reviewer\ndescription: Old\nwhenToUse: Use for reviews\ntools:\n  - Read\n  - Grep\ndisallowedTools: Bash\nsubagents:\n  - explore\noverride: true\ncustomField:\n  enabled: true\n---\n\nOld prompt.\n`);
    const service = makeService();
    const current = await service.getProfile('reviewer');

    await service.update('reviewer', {
      description: 'New description',
      prompt: 'New prompt.',
      etag: current.etag,
    });

    const parsed = parseFrontmatter(await readFile(path, 'utf8'));
    expect(parsed.data).toMatchObject({
      name: 'reviewer',
      description: 'New description',
      whenToUse: 'Use for reviews',
      tools: ['Read', 'Grep'],
      disallowedTools: 'Bash',
      subagents: ['explore'],
      override: true,
      customField: { enabled: true },
    });
    expect(parsed.body.trim()).toBe('New prompt.');
  });

  it('renames in the same directory without overwriting another file', async () => {
    const dir = join(home, 'agents', 'nested');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'old.md'), '---\nname: old\ndescription: Old\n---\n\nOld.\n');
    await writeFile(join(dir, 'target.md'), '---\nname: target\ndescription: Target\n---\n\nTarget.\n');
    const service = makeService();
    const current = await service.getProfile('old');

    await expect(service.update('old', {
      newName: 'target',
      description: 'Renamed',
      prompt: 'Renamed.',
      etag: current.etag,
    })).rejects.toMatchObject({ kind: 'already_exists' });

    const renamed = await service.update('old', {
      newName: 'renamed',
      description: 'Renamed',
      prompt: 'Renamed.',
      etag: current.etag,
    });
    expect(renamed.agent.path).toBe(await realpath(join(dir, 'renamed.md')));
    await expect(readFile(join(dir, 'old.md'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(dir, 'renamed.md'), 'utf8')).toContain('name: renamed');
  });

  it('rejects invalid names, builtin conflicts and stale writes', async () => {
    const service = makeService();
    await expect(service.create({ name: '../bad', description: 'Bad', prompt: 'Bad.' })).rejects.toMatchObject({ kind: 'validation' });
    await expect(service.create({ name: 'coder', description: 'Bad', prompt: 'Bad.' })).rejects.toMatchObject({ kind: 'already_exists' });

    const created = await service.create({ name: 'reviewer', description: 'Review', prompt: 'Review.' });
    await writeFile(join(home, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: External\n---\n\nExternal.\n');
    await expect(service.update('reviewer', {
      description: 'Local',
      prompt: 'Local.',
      etag: created.agent.etag,
    })).rejects.toMatchObject({ kind: 'stale' });
    expect(await readFile(join(home, 'agents', 'reviewer.md'), 'utf8')).toContain('External');
  });

  it('deletes only the selected file and reports skipped files', async () => {
    const dir = join(home, 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.md'), 'not an agent');
    const service = makeService();
    const created = await service.create({ name: 'reviewer', description: 'Review', prompt: 'Review.' });

    expect((await service.list()).skipped).toHaveLength(1);
    await service.delete('reviewer', created.agent.etag);

    await expect(service.getProfile('reviewer')).rejects.toMatchObject({ kind: 'not_found' });
    expect(await readFile(join(dir, 'broken.md'), 'utf8')).toBe('not an agent');
  });

  it('separates successful writes from workspace refresh failures', async () => {
    const service = makeService(async () => { throw new Error('reload failed'); });

    const result = await service.create({ name: 'reviewer', description: 'Review', prompt: 'Review.' });

    expect(result.refreshError).toContain('1 workspace');
    expect(await readFile(join(home, 'agents', 'reviewer.md'), 'utf8')).toContain('name: reviewer');
    expect((await service.refresh()).refreshError).toContain('1 workspace');
  });
});
