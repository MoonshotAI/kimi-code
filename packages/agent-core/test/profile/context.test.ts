import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgentsMd } from '../../src/profile/context';
import { testKaos } from '../fixtures/test-kaos';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

let homeDir: string;
let workDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-agents-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-agents-work-'));
  vi.spyOn(testKaos, 'gethome').mockReturnValue(homeDir);
  vi.spyOn(testKaos, 'getcwd').mockReturnValue(workDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('loadAgentsMd user-level discovery', () => {
  it('loads user-level branded and generic files before project-level', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'user branded', 'utf-8');
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'user generic', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('user branded');
    expect(result).toContain('user generic');
    expect(result).toContain('project instructions');
    expect(result.indexOf('user branded')).toBeLessThan(result.indexOf('user generic'));
    expect(result.indexOf('user generic')).toBeLessThan(result.indexOf('project instructions'));
  });

  it('loads generic user-level .agents/AGENTS.md', async () => {
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'dot-agents generic', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('dot-agents generic');
  });

  it('falls back to project-level only when no user-level files exist', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project only', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('project only');
    expect(result).not.toContain(homeDir);
  });

  it('does not load the same file twice when the work dir is the home dir', async () => {
    vi.spyOn(testKaos, 'getcwd').mockReturnValue(homeDir);
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'home branded', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result.split('home branded').length - 1).toBe(1);
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

    const result = await loadAgentsMd(testKaos, brandHome);

    expect(result).toContain('brand home instructions');
    expect(result).toContain('real home generic');
  });

  it('ignores the real-home .kimi-code/AGENTS.md when the brand home is elsewhere', async () => {
    await writeFile(join(brandHome, 'AGENTS.md'), 'brand wins', 'utf-8');
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'stale real-home brand', 'utf-8');

    const result = await loadAgentsMd(testKaos, brandHome);

    expect(result).toContain('brand wins');
    expect(result).not.toContain('stale real-home brand');
  });

  it('falls back to the real-home .kimi-code/AGENTS.md when no brand home is given', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'fallback branded', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('fallback branded');
  });
});

describe('loadAgentsMd Claude compatibility', () => {
  it('loads Claude instruction files alongside Kimi-native instructions', async () => {
    const projectRoot = join(workDir, 'repo');
    const leafDir = join(projectRoot, 'packages', 'app');
    vi.spyOn(testKaos, 'getcwd').mockReturnValue(leafDir);

    await mkdir(join(projectRoot, '.git'), { recursive: true });
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await mkdir(join(projectRoot, '.kimi-code'), { recursive: true });
    await mkdir(leafDir, { recursive: true });

    await writeFile(join(projectRoot, '.claude', 'CLAUDE.md'), 'root claude dir', 'utf-8');
    await writeFile(join(projectRoot, 'CLAUDE.md'), 'root claude upper', 'utf-8');
    await writeFile(join(projectRoot, '.kimi-code', 'AGENTS.md'), 'root branded agents', 'utf-8');
    await writeFile(join(projectRoot, 'AGENTS.md'), 'root agents', 'utf-8');
    await writeFile(join(leafDir, 'claude.md'), 'leaf claude lower', 'utf-8');
    await writeFile(join(leafDir, 'AGENTS.md'), 'leaf agents', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('root claude dir');
    expect(result).toContain('root claude upper');
    expect(result).toContain('root branded agents');
    expect(result).toContain('root agents');
    expect(result).toContain('leaf claude lower');
    expect(result).toContain('leaf agents');
    expect(result.indexOf('root claude dir')).toBeLessThan(result.indexOf('root claude upper'));
    expect(result.indexOf('root claude upper')).toBeLessThan(
      result.indexOf('root branded agents'),
    );
    expect(result.indexOf('root branded agents')).toBeLessThan(result.indexOf('root agents'));
    expect(result.indexOf('leaf claude lower')).toBeLessThan(result.indexOf('leaf agents'));
  });

  it('prefers CLAUDE.md over claude.md in the same directory', async () => {
    const files = new Map([
      ['/repo/CLAUDE.md', 'upper claude'],
      ['/repo/claude.md', 'lower claude'],
    ]);
    const dirs = new Set(['/repo', '/repo/.git']);
    const kaos = createFakeKaos({
      getcwd: () => '/repo',
      stat: vi.fn(async (path: string) => {
        if (dirs.has(path)) return stat('dir');
        if (files.has(path)) return stat('file');
        throw new Error(`ENOENT ${path}`);
      }),
      readText: vi.fn(async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT ${path}`);
        return content;
      }),
    });

    const result = await loadAgentsMd(kaos);

    expect(result).toContain('upper claude');
    expect(result).not.toContain('lower claude');
  });
});

function stat(kind: 'dir' | 'file') {
  return {
    stMode: kind === 'dir' ? 0o040000 : 0o100000,
    stIno: 0,
    stDev: 0,
    stNlink: 1,
    stUid: 0,
    stGid: 0,
    stSize: 0,
    stAtime: 0,
    stMtime: 0,
    stCtime: 0,
  };
}
