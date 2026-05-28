import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { localKaos } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadMemory } from '../../src/memory/loader';
import { DEFAULT_AGENT_PROFILES } from '../../src/profile/default';
import { loadAgentsMd, prepareSystemPromptContext } from '../../src/profile/context';
import type { SystemPromptContext } from '../../src/profile/types';
import type { TelemetryClient } from '../../src/telemetry';

let homeDir: string;
let workDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-agents-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-agents-work-'));
  vi.spyOn(localKaos, 'gethome').mockReturnValue(homeDir);
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

    const result = await loadAgentsMd(localKaos, workDir);

    expect(result).toContain('user branded');
    expect(result).toContain('user generic');
    expect(result).toContain('project instructions');
    expect(result.indexOf('user branded')).toBeLessThan(result.indexOf('user generic'));
    expect(result.indexOf('user generic')).toBeLessThan(result.indexOf('project instructions'));
  });

  it('loads generic user-level .agents/AGENTS.md', async () => {
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'dot-agents generic', 'utf-8');

    const result = await loadAgentsMd(localKaos, workDir);

    expect(result).toContain('dot-agents generic');
  });

  it('falls back to project-level only when no user-level files exist', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project only', 'utf-8');

    const result = await loadAgentsMd(localKaos, workDir);

    expect(result).toContain('project only');
    expect(result).not.toContain(homeDir);
  });

  it('does not load the same file twice when the work dir is the home dir', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'home branded', 'utf-8');

    const result = await loadAgentsMd(localKaos, homeDir);

    expect(result.split('home branded').length - 1).toBe(1);
  });
});

describe('loadMemory storage with layered scopes', () => {
  const userMemoryDir = (): string => join(homeDir, '.kimi-code', 'memory');
  const projectMemoryDir = (): string => join(workDir, '.kimi-code', 'memory');

  const writeMemoryFile = async (
    dir: string,
    slug: string,
    record: { name: string; description: string; type: string },
    body = 'body',
  ): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const text = `---\nname: ${record.name}\ndescription: ${record.description}\ntype: ${record.type}\n---\n\n${body}\n`;
    await writeFile(join(dir, `${slug}.md`), text, 'utf-8');
  };

  const markAsGitRepo = async (): Promise<void> => {
    await mkdir(join(workDir, '.git'), { recursive: true });
  };

  it('loads from user scope only when project scope is absent', async () => {
    await markAsGitRepo();
    await writeMemoryFile(userMemoryDir(), 'code-style', {
      name: 'code-style',
      description: 'Prefer concise answers.',
      type: 'user',
    });

    const result = await loadMemory(localKaos, workDir);

    expect(result).toContain('[code-style](code-style.md)');
    expect(result).toContain(userMemoryDir());
    expect(result).toContain('## User');
    expect(result).not.toContain('## Project');
  });

  it('loads from project scope only when user scope is absent', async () => {
    await markAsGitRepo();
    await writeMemoryFile(projectMemoryDir(), 'build-commands', {
      name: 'build-commands',
      description: 'Use pnpm not npm.',
      type: 'project',
    });

    const result = await loadMemory(localKaos, workDir);

    expect(result).toContain('[build-commands](build-commands.md)');
    expect(result).toContain(projectMemoryDir());
    expect(result).toContain('## Project');
  });

  it('merges user and project indexes with project rendered first', async () => {
    await markAsGitRepo();
    await writeMemoryFile(userMemoryDir(), 'code-style', {
      name: 'code-style',
      description: 'Prefer concise answers.',
      type: 'user',
    });
    await writeMemoryFile(projectMemoryDir(), 'build-commands', {
      name: 'build-commands',
      description: 'Use pnpm not npm.',
      type: 'project',
    });

    const result = await loadMemory(localKaos, workDir);

    expect(result).toContain('[code-style](code-style.md)');
    expect(result).toContain('[build-commands](build-commands.md)');
    expect(result.indexOf('## Project')).toBeLessThan(result.indexOf('## User'));
  });

  it('renders only the project entry when slugs collide across scopes', async () => {
    await markAsGitRepo();
    await writeMemoryFile(userMemoryDir(), 'code-style', {
      name: 'code-style',
      description: 'global default',
      type: 'user',
    });
    await writeMemoryFile(projectMemoryDir(), 'code-style', {
      name: 'code-style',
      description: 'repo-specific',
      type: 'project',
    });

    const result = await loadMemory(localKaos, workDir);

    const matches = result.match(/\[code-style\]\(code-style\.md\)/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(result).toContain('repo-specific');
    expect(result).not.toContain('global default');

    const userFileText = await localKaos.readText(join(userMemoryDir(), 'code-style.md'));
    expect(userFileText).toContain('global default');
  });

  it('renders the same fact on a fresh load (subagent inheritance via disk read)', async () => {
    await markAsGitRepo();
    await writeMemoryFile(projectMemoryDir(), 'test-runner', {
      name: 'test-runner',
      description: 'Use vitest run.',
      type: 'project',
    });

    const parentResult = await loadMemory(localKaos, workDir);
    expect(parentResult).toContain('[test-runner](test-runner.md)');

    const subagentResult = await loadMemory(localKaos, workDir);
    expect(subagentResult).toContain('[test-runner](test-runner.md)');
    expect(subagentResult).toBe(parentResult);
  });

  it('returns empty string when no memory directories exist', async () => {
    await markAsGitRepo();

    const result = await loadMemory(localKaos, workDir);

    expect(result).toBe('');
  });

  it('skips project-scope lookup when working directory is not inside a git repo', async () => {
    await writeMemoryFile(userMemoryDir(), 'global-pref', {
      name: 'global-pref',
      description: 'Be concise.',
      type: 'user',
    });
    const statSpy = vi.spyOn(localKaos, 'stat');

    const result = await loadMemory(localKaos, workDir);

    expect(result).toContain('[global-pref](global-pref.md)');
    expect(result).not.toContain('## Project');
    const inspectedProjectMemory = statSpy.mock.calls.some(
      ([path]) => typeof path === 'string' && path.startsWith(projectMemoryDir()),
    );
    expect(inspectedProjectMemory).toBe(false);
  });

  it('skips the reserved MEMORY.md filename during scope scan', async () => {
    await markAsGitRepo();
    await mkdir(projectMemoryDir(), { recursive: true });
    await writeFile(
      join(projectMemoryDir(), 'MEMORY.md'),
      '---\nname: memory\ndescription: reserved\ntype: project\n---\n\nbody\n',
      'utf-8',
    );

    const result = await loadMemory(localKaos, workDir);

    expect(result).not.toContain('[memory](memory.md)');
    expect(result).toBe('');
  });
});

describe('system prompt: KIMI_MEMORY', () => {
  const baseContext = (overrides: Partial<SystemPromptContext>): SystemPromptContext => ({
    osEnv: {
      osKind: 'macOS',
      osArch: 'arm64',
      osVersion: '0',
      shellName: 'bash',
      shellPath: '/bin/bash',
    },
    cwd: '/workspace',
    now: '2026-05-09T00:00:00.000Z',
    ...overrides,
  });

  const renderDefaultPrompt = (context: SystemPromptContext): string => {
    const profile = DEFAULT_AGENT_PROFILES['agent'];
    if (profile === undefined) throw new Error('expected default agent profile to be present');
    return profile.systemPrompt(context);
  };

  const fixtureIndex = [
    '<!-- kimi-code memory index — v1 -->',
    '<!-- Generated from per-fact .md files. Edit facts, not this section. -->',
    '',
    '## Project (/workspace/.kimi-code/memory)',
    '- [build-commands](build-commands.md) (project) — Use pnpm not npm.',
    '',
    '## User (~/.kimi-code/memory)',
    '- [code-style](code-style.md) (user) — Prefer concise answers.',
    '',
  ].join('\n');

  it('renders the merged index between Project Information and Skills', () => {
    const prompt = renderDefaultPrompt(baseContext({ memoryIndex: fixtureIndex }));

    expect(prompt).toContain('# Memory');
    expect(prompt).toContain('[code-style](code-style.md)');
    expect(prompt).toContain('[build-commands](build-commands.md)');

    const projectInfoIndex = prompt.indexOf('# Project Information');
    const memoryIndex = prompt.indexOf('# Memory');
    const skillsIndex = prompt.indexOf('# Skills');
    expect(projectInfoIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeGreaterThan(projectInfoIndex);
    expect(skillsIndex).toBeGreaterThan(memoryIndex);
  });

  it('keeps the source-path annotations from the loader', () => {
    const prompt = renderDefaultPrompt(baseContext({ memoryIndex: fixtureIndex }));

    expect(prompt).toContain('## Project (/workspace/.kimi-code/memory)');
    expect(prompt).toContain('## User (~/.kimi-code/memory)');
  });

  it('omits the Memory section entirely when the merged set is empty', () => {
    const prompt = renderDefaultPrompt(baseContext({ memoryIndex: '' }));

    expect(prompt).not.toContain('# Memory');
    expect(prompt).not.toContain('## Project (');
    expect(prompt).not.toContain('## User (');
    expect(prompt).not.toContain('truncated');
  });

  it('drops User entries first then Project entries when the index exceeds 8 KB and appends the sentinel', async () => {
    await mkdir(join(workDir, '.git'), { recursive: true });

    const longDesc =
      'A purposely lengthy description that consumes meaningful bytes per index line so the rendered output crosses the 8 KB budget after enough entries.';

    const projectMemoryDir = join(workDir, '.kimi-code', 'memory');
    const userMemoryDir = join(homeDir, '.kimi-code', 'memory');
    await mkdir(projectMemoryDir, { recursive: true });
    await mkdir(userMemoryDir, { recursive: true });

    const seed = async (
      dir: string,
      slug: string,
      type: 'project' | 'user',
    ): Promise<void> => {
      const text = `---\nname: ${slug}\ndescription: ${longDesc}\ntype: ${type}\n---\n\nbody\n`;
      await writeFile(join(dir, `${slug}.md`), text, 'utf-8');
    };

    for (let i = 0; i < 30; i++) {
      const slug = `project-${String(i).padStart(2, '0')}`;
      await seed(projectMemoryDir, slug, 'project');
    }
    for (let i = 0; i < 30; i++) {
      const slug = `user-${String(i).padStart(2, '0')}`;
      await seed(userMemoryDir, slug, 'user');
    }

    const memoryIndex = await loadMemory(localKaos, workDir);

    expect(Buffer.byteLength(memoryIndex, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(memoryIndex).toContain('truncated');
    expect(memoryIndex).toMatch(
      /<!-- truncated: \d+ entries omitted; call Memory\.list for the full set -->/,
    );

    // User entries drop in reverse-alpha (highest suffix first); once all
    // user entries are gone, project entries drop in reverse-alpha.
    const userMatches = memoryIndex.match(/\[user-(\d{2})\]/g) ?? [];
    const projectMatches = memoryIndex.match(/\[project-(\d{2})\]/g) ?? [];

    // If any user entry survives, the highest-numbered ones must be the ones that dropped.
    if (userMatches.length > 0) {
      const survivingUserNums = userMatches
        .map((m) => Number((/\d{2}/.exec(m) ?? ['0'])[0]))
        .toSorted((a, b) => a - b);
      const lastSurvivingUser = survivingUserNums.at(-1)!;
      expect(lastSurvivingUser).toBeLessThan(29);
      // No user entry should survive while a higher-numbered one is dropped.
      expect(survivingUserNums[0]).toBe(0);
    }

    // Once user entries are exhausted, project entries drop reverse-alpha.
    if (userMatches.length === 0 && projectMatches.length > 0) {
      const survivingProjectNums = projectMatches
        .map((m) => Number((/\d{2}/.exec(m) ?? ['0'])[0]))
        .toSorted((a, b) => a - b);
      expect(survivingProjectNums[0]).toBe(0);
      expect(survivingProjectNums.at(-1)).toBeLessThan(29);
    }

    // Dropped slugs remain on disk: the full set is still readable.
    const onDiskProject = (await import('node:fs/promises')).readdir(projectMemoryDir);
    expect((await onDiskProject).length).toBe(30);
  });
});

describe('memory resilience: survives /compact and session restart', () => {
  const userMemoryDir = (): string => join(homeDir, '.kimi-code', 'memory');
  const projectMemoryDir = (): string => join(workDir, '.kimi-code', 'memory');

  const writeMemoryFile = async (
    dir: string,
    slug: string,
    record: { name: string; description: string; type: string },
    body = 'body',
  ): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const text = `---\nname: ${record.name}\ndescription: ${record.description}\ntype: ${record.type}\n---\n\n${body}\n`;
    await writeFile(join(dir, `${slug}.md`), text, 'utf-8');
  };

  const markAsGitRepo = async (): Promise<void> => {
    await mkdir(join(workDir, '.git'), { recursive: true });
  };

  const baseEnv = (): SystemPromptContext['osEnv'] => ({
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  });

  const renderDefaultPrompt = (context: SystemPromptContext): string => {
    const profile = DEFAULT_AGENT_PROFILES['agent'];
    if (profile === undefined) throw new Error('expected default agent profile to be present');
    return profile.systemPrompt(context);
  };

  it('resuming a session re-reads memory from disk via prepareSystemPromptContext', async () => {
    await markAsGitRepo();
    await writeMemoryFile(projectMemoryDir(), 'fact-x', {
      name: 'fact-x',
      description: 'Previous session wrote this fact.',
      type: 'project',
    });

    // Fresh prepareSystemPromptContext call simulates a session resume: no
    // shared cache, the loader reads from disk on every invocation.
    const prepared = await prepareSystemPromptContext(localKaos, workDir);
    expect(prepared.memoryIndex).toContain('[fact-x](fact-x.md)');

    const prompt = renderDefaultPrompt({
      osEnv: baseEnv(),
      now: '2026-05-28T00:00:00.000Z',
      ...prepared,
    });
    expect(prompt).toContain('# Memory');
    expect(prompt).toContain('[fact-x](fact-x.md)');
  });

  it('/compact preserves memory injection: second render still contains fact and no duplicate section', async () => {
    await markAsGitRepo();
    await writeMemoryFile(projectMemoryDir(), 'fact-y', {
      name: 'fact-y',
      description: 'Fact y survives compaction.',
      type: 'project',
    });

    const beforeCompact = await prepareSystemPromptContext(localKaos, workDir);
    const beforePrompt = renderDefaultPrompt({
      osEnv: baseEnv(),
      now: '2026-05-28T00:00:00.000Z',
      ...beforeCompact,
    });
    expect(beforePrompt).toContain('[fact-y](fact-y.md)');
    expect((beforePrompt.match(/^# Memory$/gm) ?? []).length).toBe(1);

    // Simulated /compact step: the next turn re-renders the system prompt
    // via the same path used by Session.bootstrapAgentProfile.
    const afterCompact = await prepareSystemPromptContext(localKaos, workDir);
    const afterPrompt = renderDefaultPrompt({
      osEnv: baseEnv(),
      now: '2026-05-28T01:00:00.000Z',
      ...afterCompact,
    });
    expect(afterPrompt).toContain('[fact-y](fact-y.md)');
    expect((afterPrompt.match(/^# Memory$/gm) ?? []).length).toBe(1);
  });

  it('subagent write becomes visible to parent on next turn (next prepareSystemPromptContext)', async () => {
    await markAsGitRepo();

    // Turn 1: parent has no memory yet, renders its first prompt.
    const firstPrep = await prepareSystemPromptContext(localKaos, workDir);
    const firstPrompt = renderDefaultPrompt({
      osEnv: baseEnv(),
      now: '2026-05-28T00:00:00.000Z',
      ...firstPrep,
    });
    expect(firstPrompt).not.toContain('newfact');

    // Subagent writes a fact to the project scope (post-Turn-1, pre-Turn-2).
    await writeMemoryFile(projectMemoryDir(), 'newfact', {
      name: 'newfact',
      description: 'Subagent wrote this between turns.',
      type: 'project',
    });

    // Parent's first prompt (already committed) must NOT have been mutated.
    expect(firstPrompt).not.toContain('newfact');

    // Turn 2: parent re-prepares its system prompt; the new fact shows up.
    const secondPrep = await prepareSystemPromptContext(localKaos, workDir);
    const secondPrompt = renderDefaultPrompt({
      osEnv: baseEnv(),
      now: '2026-05-28T01:00:00.000Z',
      ...secondPrep,
    });
    expect(secondPrompt).toContain('[newfact](newfact.md)');
  });

  it('user scope on resume: a previous fact in user scope is re-rendered after a fresh context', async () => {
    await markAsGitRepo();
    await writeMemoryFile(userMemoryDir(), 'fact-u', {
      name: 'fact-u',
      description: 'User-scope fact from a prior session.',
      type: 'user',
    });

    const prepared = await prepareSystemPromptContext(localKaos, workDir);
    const prompt = renderDefaultPrompt({
      osEnv: baseEnv(),
      now: '2026-05-28T00:00:00.000Z',
      ...prepared,
    });
    expect(prompt).toContain('[fact-u](fact-u.md)');
  });
});

describe('memory telemetry: index truncation', () => {
  type TrackCall = readonly [string, Readonly<Record<string, unknown>> | undefined];

  const makeTelemetry = (): { client: TelemetryClient; calls: TrackCall[] } => {
    const calls: TrackCall[] = [];
    const client: TelemetryClient = {
      track: (event, properties) => {
        calls.push([event, properties as Readonly<Record<string, unknown>> | undefined]);
      },
    };
    return { client, calls };
  };

  it('fires memory_index_truncated with {droppedCount} when the rendered index exceeds 8 KB', async () => {
    await mkdir(join(workDir, '.git'), { recursive: true });

    const longDesc =
      'A purposely lengthy description that consumes meaningful bytes per index line so the rendered output crosses the 8 KB budget after enough entries.';

    const projectMemoryDir = join(workDir, '.kimi-code', 'memory');
    const userMemoryDir = join(homeDir, '.kimi-code', 'memory');
    await mkdir(projectMemoryDir, { recursive: true });
    await mkdir(userMemoryDir, { recursive: true });

    const seed = async (
      dir: string,
      slug: string,
      type: 'project' | 'user',
    ): Promise<void> => {
      const text = `---\nname: ${slug}\ndescription: ${longDesc}\ntype: ${type}\n---\n\nbody\n`;
      await writeFile(join(dir, `${slug}.md`), text, 'utf-8');
    };

    for (let i = 0; i < 30; i++) {
      await seed(projectMemoryDir, `project-${String(i).padStart(2, '0')}`, 'project');
    }
    for (let i = 0; i < 30; i++) {
      await seed(userMemoryDir, `user-${String(i).padStart(2, '0')}`, 'user');
    }

    const { client, calls } = makeTelemetry();
    const rendered = await loadMemory(localKaos, workDir, client);

    expect(rendered).toContain('truncated');

    const event = calls.find(([name]) => name === 'memory_index_truncated');
    expect(event).toBeDefined();
    const payload = event![1];
    expect(payload).toBeDefined();
    const droppedCount = (payload as { droppedCount: unknown }).droppedCount;
    expect(typeof droppedCount).toBe('number');
    expect(droppedCount).toBeGreaterThan(0);
  });

  it('does NOT fire memory_index_truncated when the index fits the 8 KB budget', async () => {
    await mkdir(join(workDir, '.git'), { recursive: true });
    const projectMemoryDir = join(workDir, '.kimi-code', 'memory');
    await mkdir(projectMemoryDir, { recursive: true });
    await writeFile(
      join(projectMemoryDir, 'small.md'),
      '---\nname: small\ndescription: tiny\ntype: project\n---\n\nbody\n',
      'utf-8',
    );

    const { client, calls } = makeTelemetry();
    await loadMemory(localKaos, workDir, client);

    const event = calls.find(([name]) => name === 'memory_index_truncated');
    expect(event).toBeUndefined();
  });

  it('swallows telemetry sink errors so loadMemory still returns a rendered index', async () => {
    await mkdir(join(workDir, '.git'), { recursive: true });
    const projectMemoryDir = join(workDir, '.kimi-code', 'memory');
    const userMemoryDir = join(homeDir, '.kimi-code', 'memory');
    const longDesc =
      'A purposely lengthy description that consumes meaningful bytes per index line so the rendered output crosses the 8 KB budget after enough entries.';
    await mkdir(projectMemoryDir, { recursive: true });
    await mkdir(userMemoryDir, { recursive: true });
    for (let i = 0; i < 30; i++) {
      const slug = `project-${String(i).padStart(2, '0')}`;
      const text = `---\nname: ${slug}\ndescription: ${longDesc}\ntype: project\n---\n\nbody\n`;
      await writeFile(join(projectMemoryDir, `${slug}.md`), text, 'utf-8');
    }
    for (let i = 0; i < 30; i++) {
      const slug = `user-${String(i).padStart(2, '0')}`;
      const text = `---\nname: ${slug}\ndescription: ${longDesc}\ntype: user\n---\n\nbody\n`;
      await writeFile(join(userMemoryDir, `${slug}.md`), text, 'utf-8');
    }

    const throwingClient: TelemetryClient = {
      track: () => {
        throw new Error('sink down');
      },
    };

    const rendered = await loadMemory(localKaos, workDir, throwingClient);
    expect(rendered).toContain('truncated');
  });
});
