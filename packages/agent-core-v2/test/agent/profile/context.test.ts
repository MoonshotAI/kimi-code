import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  extractAgentsMdPathsFromSystemPrompt,
  loadAgentsMd,
  loadAgentsMdDetailed,
  prepareSystemPromptContext,
  REPO_MAP_MAX_LINES,
} from '#/agent/profile/context';
import { parseGitmodulesPaths } from '#/agent/profile/repoMap';

function createFs(): IHostFileSystem {
  return new HostFileSystem();
}

let fs: IHostFileSystem;
let homeDir: string;
let workDir: string;
let extraDirs: string[];

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-agents-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-agents-work-'));
  extraDirs = [];
  fs = createFs();
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  await Promise.all(extraDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadAgentsMd user-level discovery', () => {
  it('loads user-level branded and generic files before project-level', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'user branded', 'utf-8');
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'user generic', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain('user branded');
    expect(result).toContain('user generic');
    expect(result).toContain('project instructions');
    expect(result.indexOf('user branded')).toBeLessThan(result.indexOf('user generic'));
    expect(result.indexOf('user generic')).toBeLessThan(result.indexOf('project instructions'));
  });

  it('loads generic user-level .agents/AGENTS.md', async () => {
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'dot-agents generic', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain('dot-agents generic');
  });

  it('falls back to project-level only when no user-level files exist', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project only', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain('project only');
    expect(result).not.toContain(homeDir);
  });

  it('does not load the same file twice when the work dir is the home dir', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'home branded', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, homeDir);

    expect(result.split('home branded').length - 1).toBe(1);
  });
});

describe('loadAgentsMd symlinked files', () => {
  it('follows symlinks when loading user-level and project-level AGENTS.md', async () => {
    const targetDir = await mkdtemp(join(tmpdir(), 'kimi-agents-target-'));
    extraDirs.push(targetDir);
    const brandTarget = join(targetDir, 'brand-AGENTS.md');
    const projectTarget = join(targetDir, 'project-AGENTS.md');
    await writeFile(brandTarget, 'brand via symlink', 'utf-8');
    await writeFile(projectTarget, 'project via symlink', 'utf-8');

    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await symlink(brandTarget, join(homeDir, '.kimi-code', 'AGENTS.md'));
    await symlink(projectTarget, join(workDir, 'AGENTS.md'));

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain('brand via symlink');
    expect(result).toContain('project via symlink');
  });
});

describe('loadAgentsMd unreadable paths', () => {
  it('warns when an instruction file exists but is a dangling symlink', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    await symlink(join(workDir, 'missing-target.md'), join(workDir, 'AGENTS.md'));

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome);

    expect(result.agentsMd).toBe('');
    expect(result.agentsMdWarning).toBeDefined();
    expect(result.agentsMdWarning).toContain('not a readable regular file');
  });
});

describe('loadAgentsMd brand home (KIMI_CODE_HOME)', () => {
  let brandHome: string;

  beforeEach(async () => {
    brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
  });

  afterEach(async () => {
    await rm(brandHome, { recursive: true, force: true });
  });

  it('loads the branded AGENTS.md from the brand home and generic from the real home', async () => {
    await writeFile(join(brandHome, 'AGENTS.md'), 'brand home instructions', 'utf-8');
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'real home generic', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir, brandHome);

    expect(result).toContain('brand home instructions');
    expect(result).toContain('real home generic');
  });

  it('ignores the real-home .kimi-code/AGENTS.md when the brand home is elsewhere', async () => {
    await writeFile(join(brandHome, 'AGENTS.md'), 'brand wins', 'utf-8');
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'stale real-home brand', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir, brandHome);

    expect(result).toContain('brand wins');
    expect(result).not.toContain('stale real-home brand');
  });

  it('falls back to the real-home .kimi-code/AGENTS.md when no brand home is given', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'fallback branded', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain('fallback branded');
  });
});

describe('loadAgentsMd nested project hierarchy', () => {
  it('loads AGENTS.md from the project root down to the cwd in root→leaf order', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kimi-agents-project-'));
    extraDirs.push(projectRoot);
    const leaf = join(projectRoot, 'packages', 'app');
    await mkdir(leaf, { recursive: true });
    await mkdir(join(projectRoot, '.git'));
    await writeFile(join(projectRoot, 'AGENTS.md'), 'root instructions', 'utf-8');
    await writeFile(join(projectRoot, 'packages', 'AGENTS.md'), 'packages instructions', 'utf-8');
    await writeFile(join(leaf, 'AGENTS.md'), 'leaf instructions', 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, leaf);

    expect(result).toContain('root instructions');
    expect(result).toContain('packages instructions');
    expect(result).toContain('leaf instructions');
    expect(result.indexOf('root instructions')).toBeLessThan(result.indexOf('packages instructions'));
    expect(result.indexOf('packages instructions')).toBeLessThan(result.indexOf('leaf instructions'));
  });
});

describe('loadAgentsMd oversized content', () => {
  it('keeps the full content when AGENTS.md exceeds the recommended size', async () => {
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');

    const result = await loadAgentsMd({ fs, homeDir }, workDir);

    expect(result).toContain(largeContent);
    expect(result).not.toContain('truncated or omitted');
  });
});

describe('prepareSystemPromptContext AGENTS.md size warning', () => {
  it('returns agentsMdWarning and keeps full content when oversized', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome);

    expect(result.agentsMd).toContain(largeContent);
    expect(result.agentsMdWarning).toBeDefined();
    expect(result.agentsMdWarning).toContain('exceeds the recommended');
  });

  it('does not return agentsMdWarning when within the recommended size', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome);

    expect(result.agentsMdWarning).toBeUndefined();
  });
});

describe('prepareSystemPromptContext additional directories', () => {
  it('includes additional directory listings without loading their AGENTS.md', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-empty-brand-'));
    extraDirs.push(brandHome);
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-'));
    extraDirs.push(extraDir);

    await writeFile(join(workDir, 'AGENTS.md'), 'repo project instructions', 'utf-8');
    await writeFile(join(extraDir, 'AGENTS.md'), 'extra project instructions', 'utf-8');
    await writeFile(join(extraDir, 'extra-file.txt'), 'extra listing entry', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome, {
      additionalDirs: [extraDir],
    });

    const agentsMd = result.agentsMd ?? '';

    expect(result.cwdListing).toBeTypeOf('string');
    expect(result.additionalDirsInfo).toContain(`### ${extraDir}`);
    expect(result.additionalDirsInfo).toContain('extra-file.txt');
    expect(agentsMd).toContain('repo project instructions');
    expect(agentsMd).not.toContain('extra project instructions');
    expect(agentsMd.split('<!-- From:').length - 1).toBe(1);
  });

  it('loads user-level AGENTS.md once and skips additional directory AGENTS.md', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-empty-brand-'));
    extraDirs.push(brandHome);
    const extraDirA = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-a-'));
    const extraDirB = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-b-'));
    extraDirs.push(extraDirA, extraDirB);

    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'shared user instructions', 'utf-8');
    await writeFile(join(extraDirA, 'AGENTS.md'), 'extra A instructions', 'utf-8');
    await writeFile(join(extraDirB, 'AGENTS.md'), 'extra B instructions', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir, brandHome, {
      additionalDirs: [extraDirA, extraDirB],
    });

    const agentsMd = result.agentsMd ?? '';

    expect(result.additionalDirsInfo).toContain(`### ${extraDirA}`);
    expect(result.additionalDirsInfo).toContain(`### ${extraDirB}`);
    expect(agentsMd.split('shared user instructions').length - 1).toBe(1);
    expect(agentsMd).not.toContain('extra A instructions');
    expect(agentsMd).not.toContain('extra B instructions');
  });
});

describe('loadAgentsMdDetailed discovered paths', () => {
  it('recovers AGENTS.md source annotations without treating plugin annotations as files', () => {
    expect(
      extractAgentsMdPathsFromSystemPrompt(
        '<!-- From: /repo/AGENTS.md -->\nroot\n\n<!-- From: plugin example -->\nplugin',
      ),
    ).toEqual(['/repo/AGENTS.md']);
  });

  it('returns the normalized paths of every injected file in collection order', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'user branded', 'utf-8');
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(workDir, '.kimi-code', 'AGENTS.md'), 'dot kimi', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await loadAgentsMdDetailed({ fs, homeDir }, workDir);

    expect(result.paths).toEqual([
      normalize(join(homeDir, '.kimi-code', 'AGENTS.md')),
      normalize(join(workDir, '.kimi-code', 'AGENTS.md')),
      normalize(join(workDir, 'AGENTS.md')),
    ]);
  });

  it('prefers AGENTS.md over agents.md within one directory', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'upper', 'utf-8');
    await writeFile(join(workDir, 'agents.md'), 'lower', 'utf-8');

    const result = await loadAgentsMdDetailed({ fs, homeDir }, workDir);

    expect(result.paths).toEqual([normalize(join(workDir, 'AGENTS.md'))]);
  });

  it('exposes the same paths through prepareSystemPromptContext', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir);

    expect(result.agentsMdPaths).toEqual([normalize(join(workDir, 'AGENTS.md'))]);
  });
});

describe('prepareSystemPromptContext repository map', () => {
  it('returns an empty repoMap for a single repository with no nested repos', async () => {
    await mkdir(join(workDir, '.git'));
    await mkdir(join(workDir, 'packages', 'core', 'src'), { recursive: true });
    await writeFile(join(workDir, 'AGENTS.md'), 'root instructions', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir);

    expect(result.repoMap).toBe('');
  });

  it('discovers nested Git repositories with roles and AGENTS.md paths without eagerly loading their AGENTS.md', async () => {
    const cliRepo = join(workDir, 'src', 'kimi-code');
    const appRepo = join(workDir, 'src', 'code-app');
    await mkdir(join(cliRepo, '.git'), { recursive: true });
    await mkdir(join(appRepo, '.git'), { recursive: true });
    await mkdir(join(appRepo, 'kimi-code', '.git'), { recursive: true });

    await writeFile(
      join(cliRepo, 'README.md'),
      [
        '# Kimi Code CLI',
        '',
        '[![License](https://example.com/badge.svg)](LICENSE) <br>',
        '[Documentation](https://example.com/docs) · [Issues](https://example.com/issues)',
        '',
        '![Demo](./demo.gif)',
        '',
        '## What is Kimi Code CLI',
        '',
        'Kimi Code CLI is an AI coding agent that runs in your terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on feedback.',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(join(cliRepo, 'AGENTS.md'), 'cli instructions', 'utf-8');

    await writeFile(
      join(appRepo, 'README.md'),
      '# code-app\n\nDesktop (`apps/desktop`) and Web UI (`apps/web`) client repository.\n',
      'utf-8',
    );
    await writeFile(join(appRepo, 'AGENTS.md'), 'app instructions', 'utf-8');
    await writeFile(join(appRepo, 'kimi-code', 'AGENTS.md'), 'nested submodule instructions', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir);

    expect(result.repoMap).toBe(
      [
        '- `src/code-app` — Desktop (`apps/desktop`) and Web UI (`apps/web`) client repository. (`src/code-app/AGENTS.md`)',
        '- `src/kimi-code` — Kimi Code CLI is an AI coding agent that runs in your terminal (`src/kimi-code/AGENTS.md`)',
      ].join('\n'),
    );
    expect(result.agentsMd).not.toContain('cli instructions');
    expect(result.agentsMd).not.toContain('app instructions');
  });

  it('discovers gitfile submodules and deep .gitmodules entries while ignoring unsafe or uninitialized paths', async () => {
    await mkdir(join(workDir, '.git'));
    const directSubmodule = join(workDir, 'kimi-code');
    const deepSubmodule = join(workDir, 'vendor', 'sdk', 'deep', 'nested', 'proto');
    const uninitialized = join(workDir, 'vendor', 'empty-sub');
    await mkdir(directSubmodule, { recursive: true });
    await mkdir(deepSubmodule, { recursive: true });
    await mkdir(uninitialized, { recursive: true });

    await writeFile(join(directSubmodule, '.git'), 'gitdir: ../.git/modules/kimi-code\n', 'utf-8');
    await writeFile(
      join(directSubmodule, 'package.json'),
      JSON.stringify({ name: '@acme/cli', description: 'Core CLI engine' }),
      'utf-8',
    );
    await writeFile(join(deepSubmodule, '.git'), 'gitdir: ../../../../../.git/modules/proto\n', 'utf-8');
    await writeFile(
      join(deepSubmodule, 'Cargo.toml'),
      '[package]\nname = "proto-defs"\ndescription = "Shared Wire definitions"\n',
      'utf-8',
    );
    await writeFile(
      join(workDir, '.gitmodules'),
      [
        '[submodule "kimi-code"]',
        '\tpath = kimi-code',
        '[submodule "proto"]',
        '\tpath = "vendor/sdk/deep/nested/proto" # deep path',
        '[submodule "empty"]',
        '\tpath = vendor/empty-sub',
        '[submodule "escape"]',
        '\tpath = ../outside',
      ].join('\n'),
      'utf-8',
    );

    expect(
      parseGitmodulesPaths(
        '[submodule "a"]\npath = foo/bar\n[submodule "bad"]\npath = ../escape\n[other]\npath = ignored\n',
      ),
    ).toEqual(['foo/bar']);

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir);

    expect(result.repoMap).toBe(
      [
        '- `kimi-code` — Core CLI engine',
        '- `vendor/sdk/deep/nested/proto` — Shared Wire definitions',
      ].join('\n'),
    );
  });

  it('extracts roles from pyproject.toml, AGENTS.md overview sections, and module fallbacks', async () => {
    const pyRepo = join(workDir, 'py-service');
    const agentsOnlyRepo = join(workDir, 'agents-only');
    const goRepo = join(workDir, 'go-worker');
    await mkdir(join(pyRepo, '.git'), { recursive: true });
    await mkdir(join(agentsOnlyRepo, '.git'), { recursive: true });
    await mkdir(join(agentsOnlyRepo, '.kimi-code'), { recursive: true });
    await mkdir(join(goRepo, '.git'), { recursive: true });

    await writeFile(
      join(pyRepo, 'pyproject.toml'),
      '[project]\nname = "py-service"\ndescription = "Add your description here"\n[tool.poetry]\ndescription = "Async ingestion pipeline"\n',
      'utf-8',
    );
    await writeFile(join(pyRepo, 'AGENTS.md'), '   \n', 'utf-8');

    await writeFile(
      join(agentsOnlyRepo, 'AGENTS.md'),
      [
        '# Repository-level Agent Guide',
        '',
        'Reply in the same language as the user.',
        '',
        '## 仓库定位与现状',
        '',
        '- 统一网关与鉴权服务。后续补充说明。',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(join(agentsOnlyRepo, '.kimi-code', 'AGENTS.md'), 'local override', 'utf-8');

    await writeFile(join(goRepo, 'go.mod'), 'module example.com/platform/worker\n\ngo 1.23\n', 'utf-8');

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir);

    expect(result.repoMap).toBe(
      [
        '- `agents-only` — 统一网关与鉴权服务。 (`agents-only/.kimi-code/AGENTS.md`, `agents-only/AGENTS.md`)',
        '- `go-worker` — example.com/platform/worker',
        '- `py-service` — Async ingestion pipeline',
      ].join('\n'),
    );
  });

  it('follows symlinked sub-repositories at their lexical path and breaks symlink cycles', async () => {
    const externalRepo = await mkdtemp(join(tmpdir(), 'kimi-agents-ext-repo-'));
    extraDirs.push(externalRepo);
    await mkdir(join(externalRepo, '.git'));
    await writeFile(
      join(externalRepo, 'package.json'),
      JSON.stringify({ description: 'Mounted external repo' }),
      'utf-8',
    );
    await writeFile(join(externalRepo, 'AGENTS.md'), 'mounted rules', 'utf-8');

    await mkdir(join(workDir, 'src'), { recursive: true });
    await symlink(externalRepo, join(workDir, 'src', 'mounted'));
    await symlink(join(workDir, 'src'), join(workDir, 'src', 'cycle-self'));
    await symlink(workDir, join(workDir, 'src', 'cycle-root'));

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir);

    expect(result.repoMap).toBe(
      '- `src/mounted` — Mounted external repo (`src/mounted/AGENTS.md`)',
    );
  });

  it('caps the repository map at 10 lines when more than 10 sub-repositories exist', async () => {
    for (let i = 1; i <= 14; i += 1) {
      const name = `repo-${String(i).padStart(2, '0')}`;
      const dir = join(workDir, 'repos', name);
      await mkdir(join(dir, '.git'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ description: `Service ${String(i)}` }),
        'utf-8',
      );
    }

    const result = await prepareSystemPromptContext({ fs, homeDir }, workDir);
    const lines = (result.repoMap ?? '').split('\n');

    expect(lines).toHaveLength(REPO_MAP_MAX_LINES);
    expect(lines[0]).toBe('- `repos/repo-01` — Service 1');
    expect(lines[8]).toBe('- `repos/repo-09` — Service 9');
    expect(lines[9]).toBe('- ... and 5 more sub-repositories');
  });
});
