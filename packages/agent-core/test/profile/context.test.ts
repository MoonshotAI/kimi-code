import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgentsMd } from '../../src/profile/context';
import { testKaos } from '../fixtures/test-kaos';

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

  it('loads CLAUDE.md when no AGENTS.md is present', async () => {
    await writeFile(join(workDir, 'CLAUDE.md'), 'claude instructions', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('claude instructions');
  });

  it('prefers AGENTS.md over CLAUDE.md in the same directory', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'agents instructions', 'utf-8');
    await writeFile(join(workDir, 'CLAUDE.md'), 'claude instructions', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('agents instructions');
    expect(result).not.toContain('claude instructions');
  });

  it('loads ~/.claude/CLAUDE.md when no .agents file exists', async () => {
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(join(homeDir, '.claude', 'CLAUDE.md'), 'global claude memory', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('global claude memory');
  });

  it('does not load ~/.claude/CLAUDE.md when ~/.kimi-code/AGENTS.md exists', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'kimi user memory', 'utf-8');
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(join(homeDir, '.claude', 'CLAUDE.md'), 'global claude memory', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('kimi user memory');
    expect(result).not.toContain('global claude memory');
  });

  it('prefers .agents/AGENTS.md over ~/.claude/CLAUDE.md', async () => {
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'dot-agents', 'utf-8');
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(join(homeDir, '.claude', 'CLAUDE.md'), 'global claude memory', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('dot-agents');
    expect(result).not.toContain('global claude memory');
  });

  it('loads .claude/CLAUDE.md in the project directory', async () => {
    await mkdir(join(workDir, '.claude'), { recursive: true });
    await writeFile(join(workDir, '.claude', 'CLAUDE.md'), 'dot-claude instructions', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('dot-claude instructions');
  });

  it('prefers bare CLAUDE.md over .claude/CLAUDE.md in the same directory', async () => {
    await writeFile(join(workDir, 'CLAUDE.md'), 'bare claude', 'utf-8');
    await mkdir(join(workDir, '.claude'), { recursive: true });
    await writeFile(join(workDir, '.claude', 'CLAUDE.md'), 'dot-claude', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('bare claude');
    expect(result).not.toContain('dot-claude');
  });

  it('does not load CLAUDE.md when .kimi-code/AGENTS.md exists in the same scope', async () => {
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(workDir, '.kimi-code', 'AGENTS.md'), 'kimi override', 'utf-8');
    await writeFile(join(workDir, 'CLAUDE.md'), 'claude instructions', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('kimi override');
    expect(result).not.toContain('claude instructions');
  });

  it('does not load the same file twice when the work dir is the home dir', async () => {
    vi.spyOn(testKaos, 'getcwd').mockReturnValue(homeDir);
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'home branded', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result.split('home branded').length - 1).toBe(1);
  });
});
