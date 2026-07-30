/**
 * Scenario: Markdown agent parsing, discovery, binding, and session resume.
 * Responsibilities: file-defined profile identity and policies remain observable across lifecycle changes.
 * Wiring: the real catalog/session/record store are used with isolated local filesystem fixtures.
 * Run: pnpm -C packages/agent-core exec vitest run test/profile/agentfile.test.ts
 */

import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { testKaos } from '../fixtures/test-kaos';
import type { ProviderConfig } from '@moonshot-ai/kosong';

import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import {
  DEFAULT_AGENT_PROFILES,
  SessionAgentProfileCatalog,
  agentProfileFromFile,
  parseAgentFileText,
  type AgentFileRoot,
  type SystemPromptContext,
} from '../../src/profile';
import { AgentFileParseError } from '../../src/profile/agentfile/parser';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix = 'kimi-agentfile-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const promptContext: SystemPromptContext = {
  osEnv: {
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
  cwdListing: 'README.md',
  agentsMd: 'Project instructions.',
  skills: 'Available test skills.',
};

function agentFileText(frontmatter: Record<string, unknown>, body = 'You are a reviewer.'): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => {
    if (Array.isArray(value)) {
      // Quote every item: a bare `*` (or `*`-leading) entry would otherwise
      // parse as a YAML alias reference.
      return `${key}:\n${value.map((item) => `  - ${JSON.stringify(item)}`).join('\n')}`;
    }
    return `${key}: ${String(value)}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
}

describe('parseAgentFileText', () => {
  const parse = (text: string, path = '/agents/reviewer.md') =>
    parseAgentFileText({ path, source: 'project', text });

  it('parses a minimal agent file', () => {
    const definition = parse(agentFileText({ name: 'reviewer', description: 'Reviews code.' }));
    expect(definition).toMatchObject({
      name: 'reviewer',
      description: 'Reviews code.',
      override: false,
      prompt: 'You are a reviewer.',
      source: 'project',
    });
  });

  it('derives the name from the file name when omitted', () => {
    const definition = parse(agentFileText({ description: 'Reviews code.' }), '/agents/code-reviewer.md');
    expect(definition.name).toBe('code-reviewer');
  });

  it('rejects non-kebab-case names', () => {
    expect(() => parse(agentFileText({ name: 'Code Reviewer', description: 'd' }))).toThrow(
      AgentFileParseError,
    );
  });

  it('rejects a missing description', () => {
    expect(() => parse(agentFileText({ name: 'reviewer' }))).toThrow(/description/);
  });

  it('rejects missing frontmatter and an empty prompt body', () => {
    expect(() => parse('You are a reviewer.')).toThrow(/Missing frontmatter/);
    expect(() => parse(agentFileText({ description: 'd' }, '   '))).toThrow(/prompt body/);
  });

  it('accepts tools as a YAML list and as a comma-separated string', () => {
    const asList = parse(
      agentFileText({ description: 'd', tools: ['Read', 'Grep'] }),
    );
    expect(asList.tools).toEqual(['Read', 'Grep']);
    const asString = parse(
      `---\ndescription: d\ntools: Read, Grep\n---\n\nbody\n`,
    );
    expect(asString.tools).toEqual(['Read', 'Grep']);
  });

  it('normalizes a lone * in tools and subagents to unrestricted', () => {
    const definition = parse(`---\ndescription: d\ntools: '*'\nsubagents: '*'\n---\n\nbody\n`);
    expect(definition.tools).toBeUndefined();
    expect(definition.subagents).toBeUndefined();
  });

  it('parses disallowedTools, subagents, override and model_preference', () => {
    const definition = parse(
      agentFileText({
        description: 'd',
        override: true,
        disallowedTools: ['Bash'],
        subagents: ['explore'],
        model_preference: 'secondary',
      }),
    );
    expect(definition).toMatchObject({
      override: true,
      disallowedTools: ['Bash'],
      subagents: ['explore'],
      modelPreference: 'secondary',
    });
  });

  it('rejects an invalid model_preference', () => {
    expect(() => parse(agentFileText({ description: 'd', model_preference: 'cheapest' }))).toThrow(
      /model_preference/,
    );
  });

  it('ignores unknown frontmatter fields', () => {
    const definition = parse(agentFileText({ description: 'd', future_field: 'x' }));
    expect(definition.name).toBe('reviewer');
  });
});

describe('agentProfileFromFile', () => {
  const defaultTools = DEFAULT_AGENT_PROFILES['agent']!.tools;
  const basePrompt = () => 'BASE PROMPT';

  it('renders ${var} placeholders from the prompt context', () => {
    const definition = parseAgentFileText({
      path: '/agents/reviewer.md',
      source: 'project',
      text: agentFileText(
        { description: 'd' },
        'Work in ${cwd}. OS: ${os}. Instructions: ${agents_md}',
      ),
    });
    const profile = agentProfileFromFile(definition, defaultTools, basePrompt);
    expect(profile.systemPrompt(promptContext)).toBe(
      'Work in /workspace. OS: Linux. Instructions: Project instructions.',
    );
  });

  it('leaves unknown placeholders and nunjucks syntax verbatim', () => {
    const definition = parseAgentFileText({
      path: '/agents/reviewer.md',
      source: 'project',
      text: agentFileText({ description: 'd' }, 'Keep ${unknown_var} and {{ not_a_var }} literal.'),
    });
    const profile = agentProfileFromFile(definition, defaultTools, basePrompt);
    expect(profile.systemPrompt(promptContext)).toBe('Keep ${unknown_var} and {{ not_a_var }} literal.');
  });

  it('expands ${base_prompt} with the builtin default prompt', () => {
    const definition = parseAgentFileText({
      path: '/agents/reviewer.md',
      source: 'project',
      text: agentFileText({ description: 'd' }, 'Wrapper.\n${base_prompt}\nEnd.'),
    });
    const profile = agentProfileFromFile(definition, defaultTools, basePrompt);
    expect(profile.systemPrompt(promptContext)).toBe('Wrapper.\nBASE PROMPT\nEnd.');
  });

  it('injects skills only when the Skill tool survives the tool list', () => {
    const withSkill = agentProfileFromFile(
      parseAgentFileText({
        path: '/agents/a.md',
        source: 'project',
        text: agentFileText({ description: 'd' }, '${skills_section}done'),
      }),
      defaultTools,
      basePrompt,
    );
    expect(withSkill.systemPrompt(promptContext)).toContain('Available test skills.');

    const withoutSkill = agentProfileFromFile(
      parseAgentFileText({
        path: '/agents/b.md',
        source: 'project',
        text: agentFileText({ description: 'd', tools: ['Read'] }, '${skills_section}done'),
      }),
      defaultTools,
      basePrompt,
    );
    expect(withoutSkill.systemPrompt(promptContext)).toBe('done');
  });

  it('defaults tools to the default set and passes disallowedTools through', () => {
    const unrestricted = agentProfileFromFile(
      parseAgentFileText({
        path: '/agents/a.md',
        source: 'project',
        text: agentFileText({ description: 'd' }),
      }),
      defaultTools,
      basePrompt,
    );
    expect(unrestricted.tools).toEqual(defaultTools);
    expect(unrestricted.disallowedTools).toBeUndefined();

    // The denylist rides the profile (evaluated by the tool manager against
    // resolved tool names) instead of being subtracted here.
    const restricted = agentProfileFromFile(
      parseAgentFileText({
        path: '/agents/b.md',
        source: 'project',
        text: agentFileText({ description: 'd', disallowedTools: ['Bash', 'mcp__github__*'] }),
      }),
      defaultTools,
      basePrompt,
    );
    expect(restricted.tools).toEqual(defaultTools);
    expect(restricted.disallowedTools).toEqual(['Bash', 'mcp__github__*']);
  });
});

describe('SessionAgentProfileCatalog', () => {
  async function makeLayout() {
    const workDir = await makeTempDir();
    await mkdir(join(workDir, '.git'));
    const brandHome = await makeTempDir();
    const osHome = await makeTempDir();
    return { workDir, brandHome, osHome };
  }

  function catalog(options: {
    workDir: string;
    brandHomeDir: string;
    osHomeDir: string;
    extraDirs?: readonly string[];
    explicitFiles?: readonly string[];
    pluginRoots?: readonly AgentFileRoot[];
    warnings?: string[];
  }): SessionAgentProfileCatalog {
    return new SessionAgentProfileCatalog({
      workDir: options.workDir,
      brandHomeDir: options.brandHomeDir,
      osHomeDir: options.osHomeDir,
      extraDirs: options.extraDirs,
      explicitFiles: options.explicitFiles,
      pluginRoots: options.pluginRoots,
      warn: (message) => options.warnings?.push(message),
    });
  }

  async function writeAgent(dir: string, fileName: string, text: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), text, 'utf-8');
  }

  it('discovers agents from the user brand dir and the project dir', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeAgent(join(brandHome, 'agents'), 'user-agent.md', agentFileText({ description: 'User agent.' }));
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'project-agent.md',
      agentFileText({ description: 'Project agent.' }),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    expect(c.get('user-agent')?.description).toBe('User agent.');
    expect(c.get('project-agent')?.description).toBe('Project agent.');
    // The builtins are always present.
    expect(c.get('coder')).toBeDefined();
    expect(c.getDefault().name).toBe('agent');
  });

  it('lets the project source shadow the user source on the same name', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeAgent(join(brandHome, 'agents'), 'shared.md', agentFileText({ description: 'From user.' }));
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'shared.md',
      agentFileText({ description: 'From project.' }),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    expect(c.get('shared')?.description).toBe('From project.');
  });

  it('discovers plugin agents and lets the user source shadow them', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    const pluginDir = await makeTempDir();
    await writeAgent(pluginDir, 'shared.md', agentFileText({ description: 'From plugin.' }));
    await writeAgent(pluginDir, 'plugin-only.md', agentFileText({ description: 'Plugin agent.' }));
    await writeAgent(join(brandHome, 'agents'), 'shared.md', agentFileText({ description: 'From user.' }));

    const c = catalog({
      workDir,
      brandHomeDir: brandHome,
      osHomeDir: osHome,
      pluginRoots: [{ path: pluginDir, source: 'plugin' }],
    });
    await c.ready;
    expect(c.get('shared')?.description).toBe('From user.');
    expect(c.get('plugin-only')?.description).toBe('Plugin agent.');
  });

  it('requires override: true before a file replaces a same-name builtin', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    const warnings: string[] = [];
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'coder.md',
      agentFileText({ description: 'Rogue coder.' }),
    );

    const rejected = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome, warnings });
    await rejected.ready;
    expect(rejected.get('coder')?.description).toBe(DEFAULT_AGENT_PROFILES['coder']!.description);
    expect(warnings.some((w) => w.includes('override: true'))).toBe(true);

    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'coder.md',
      agentFileText({ description: 'Rogue coder.', override: true }, 'Rogue prompt.'),
    );
    const accepted = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await accepted.ready;
    expect(accepted.get('coder')?.description).toBe('Rogue coder.');
    expect(accepted.get('coder')?.systemPrompt(promptContext)).toBe('Rogue prompt.');
  });

  it('replaces the default profile prompt with SYSTEM.md', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeFile(join(brandHome, 'SYSTEM.md'), 'Custom system for ${os}.', 'utf-8');

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    expect(c.getDefault().systemPrompt(promptContext)).toBe('Custom system for Linux.');
    // Only the prompt changed; capabilities and description stay builtin.
    expect(c.getDefault().tools).toEqual(DEFAULT_AGENT_PROFILES['agent']!.tools);
    expect(Object.keys(c.delegatableSubagents('agent'))).toEqual(
      Object.keys(DEFAULT_AGENT_PROFILES['agent']!.subagents ?? {}),
    );
    expect(c.delegatableSubagents('agent')).not.toHaveProperty('agent');
  });

  it('extends SYSTEM.md delegation with custom agents without allowing self-delegation', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeFile(join(brandHome, 'SYSTEM.md'), 'Custom system.', 'utf-8');
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'reviewer.md',
      agentFileText({ description: 'Reviews code.' }),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    const expectedNames = [
      ...Object.keys(DEFAULT_AGENT_PROFILES['agent']!.subagents ?? {}),
      'reviewer',
    ];
    expect(Object.keys(c.delegatableSubagents('agent'))).toEqual(expectedNames);
    expect(c.delegatableSubagents('agent')).not.toHaveProperty('agent');

    const snapshot = c.snapshot();
    expect(snapshot).toBeDefined();
    const restoredLayout = await makeLayout();
    const restored = catalog({
      workDir: restoredLayout.workDir,
      brandHomeDir: restoredLayout.brandHome,
      osHomeDir: restoredLayout.osHome,
    });
    await restored.ready;
    restored.restoreSnapshot(snapshot!);
    expect(Object.keys(restored.delegatableSubagents('agent'))).toEqual(expectedNames);
    expect(restored.delegatableSubagents('agent')).not.toHaveProperty('agent');
  });

  it('lets a project agent.md win over SYSTEM.md', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeFile(join(brandHome, 'SYSTEM.md'), 'From SYSTEM.md', 'utf-8');
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'agent.md',
      agentFileText({ description: 'Project default.', override: true }, 'From project agent.md'),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    expect(c.getDefault().systemPrompt(promptContext)).toBe('From project agent.md');
  });

  it('fails ready for an invalid explicit agent file', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    const c = catalog({
      workDir,
      brandHomeDir: brandHome,
      osHomeDir: osHome,
      explicitFiles: ['missing.md'],
    });
    await expect(c.ready).rejects.toThrow();
  });

  it('treats an explicit file as an implicit builtin override', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    const explicitPath = join(workDir, 'explicit-coder.md');
    await writeFile(
      explicitPath,
      agentFileText({ name: 'coder', description: 'Explicit coder.' }, 'Explicit prompt.'),
      'utf-8',
    );

    const c = catalog({
      workDir,
      brandHomeDir: brandHome,
      osHomeDir: osHome,
      explicitFiles: ['explicit-coder.md'],
    });
    await c.ready;
    expect(c.get('coder')?.description).toBe('Explicit coder.');
  });

  it('uses the last explicit file when files declare the same profile name', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeFile(
      join(workDir, 'first-reviewer.md'),
      agentFileText({ name: 'reviewer', description: 'First reviewer.' }),
      'utf-8',
    );
    await writeFile(
      join(workDir, 'last-reviewer.md'),
      agentFileText({ name: 'reviewer', description: 'Last reviewer.' }),
      'utf-8',
    );

    const c = catalog({
      workDir,
      brandHomeDir: brandHome,
      osHomeDir: osHome,
      explicitFiles: ['first-reviewer.md', 'last-reviewer.md'],
    });
    await c.ready;

    expect(c.get('reviewer')?.description).toBe('Last reviewer.');
  });

  it('extends the default delegation set with file-defined agents', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'reviewer.md',
      agentFileText({ description: 'Reviews code.' }),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    const delegatable = c.delegatableSubagents('agent');
    expect(Object.keys(delegatable)).toContain('reviewer');
    expect(Object.keys(delegatable)).toContain('coder');
    // The builtin profile objects are shared constants; the extension must
    // not leak into them.
    expect(Object.keys(DEFAULT_AGENT_PROFILES['agent']!.subagents ?? {})).not.toContain('reviewer');
  });

  it('links a file profile subagents allowlist, unrestricted when omitted', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'leader.md',
      agentFileText({ description: 'Leads.', subagents: ['explore'] }),
    );
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'worker.md',
      agentFileText({ description: 'Works.' }),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    expect(Object.keys(c.delegatableSubagents('leader'))).toEqual(['explore']);
    const workerDelegatable = c.delegatableSubagents('worker');
    expect(Object.keys(workerDelegatable)).toContain('leader');
    expect(Object.keys(workerDelegatable)).toContain('coder');
  });

  it('renders a file profile prompt through the builtin base prompt', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'reviewer.md',
      agentFileText({ description: 'd' }, 'Custom.\n${base_prompt}'),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    const rendered = c.get('reviewer')!.systemPrompt(promptContext);
    expect(rendered).toContain('Custom.');
    expect(rendered).toContain('Project instructions.');
    expect(rendered.length).toBeGreaterThan('Custom.\n'.length);
  });

  it('backs ${base_prompt} with the SYSTEM.md override when present', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeFile(join(brandHome, 'SYSTEM.md'), 'Org default on ${os}.', 'utf-8');
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'reviewer.md',
      agentFileText({ description: 'd' }, '[${base_prompt}]'),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    // The agent file's ${base_prompt} expands to the effective default —
    // the SYSTEM.md override — not the builtin default.
    expect(c.get('reviewer')!.systemPrompt(promptContext)).toBe('[Org default on Linux.]');
  });

  it('chains ${base_prompt} through SYSTEM.md down to the builtin default', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeFile(join(brandHome, 'SYSTEM.md'), 'Org layer.\n${base_prompt}', 'utf-8');
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'reviewer.md',
      agentFileText({ description: 'd' }, 'File layer.\n${base_prompt}'),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    const rendered = c.get('reviewer')!.systemPrompt(promptContext);
    // Two hops: file → SYSTEM.md → builtin default (which renders agents_md).
    expect(rendered).toContain('File layer.');
    expect(rendered).toContain('Org layer.');
    expect(rendered).toContain('Project instructions.');
  });

  it('never recurses when a file overrides the default and references ${base_prompt}', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'agent.md',
      agentFileText({ description: 'Override default.', override: true }, 'Override.\n${base_prompt}'),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome });
    await c.ready;
    const rendered = c.getDefault().systemPrompt(promptContext);
    // The overriding file's base is the effective default slot (builtin
    // here), structurally disjoint from the merge — no self-reference.
    expect(rendered).toContain('Override.');
    expect(rendered).toContain('Project instructions.');
  });

  it('warns about dead tool patterns in agent files', async () => {
    const { workDir, brandHome, osHome } = await makeLayout();
    const warnings: string[] = [];
    await writeAgent(
      join(workDir, '.kimi-code', 'agents'),
      'reviewer.md',
      agentFileText({
        description: 'd',
        tools: ['Read', 'read', '*', 'mcp__github', 'mcp__github__*'],
        disallowedTools: ['Bash'],
      }),
    );

    const c = catalog({ workDir, brandHomeDir: brandHome, osHomeDir: osHome, warnings });
    await c.ready;
    // Typo (unknown tool), bare wildcard, incomplete mcp literal.
    expect(warnings.some((w) => w.includes('"read"') && w.includes('no registered or built-in tool'))).toBe(true);
    expect(warnings.some((w) => w.includes('"*"') && w.includes('wildcards only work inside mcp__'))).toBe(true);
    expect(warnings.some((w) => w.includes('"mcp__github"') && w.includes('mcp__<server>__<tool>'))).toBe(true);
    // Valid entries produce no warnings.
    expect(warnings.some((w) => w.includes('"Read"'))).toBe(false);
    expect(warnings.some((w) => w.includes('"mcp__github__*"'))).toBe(false);
    expect(warnings.some((w) => w.includes('"Bash"'))).toBe(false);
  });
});

describe('Session agentfile wiring', () => {
  function createSessionRpc(): SDKSessionRPC {
    return {
      emitEvent: vi.fn(async () => {}),
      requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ content: [] })),
    } as unknown as SDKSessionRPC;
  }

  function testProviderManager(): ProviderManager {
    return new ProviderManager({
      config: {
        providers: { test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey } },
        defaultProvider: 'test',
        defaultModel: MOCK_PROVIDER.model,
        models: {
          [MOCK_PROVIDER.model]: {
            provider: 'test',
            model: MOCK_PROVIDER.model,
            maxContextSize: 1_000_000,
          },
        },
      },
    });
  }

  it('binds a file-defined main profile selected by profileName', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const brandHome = await makeTempDir();
    const osHome = await makeTempDir();
    await mkdir(join(workDir, '.kimi-code', 'agents'), { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'agents', 'reviewer.md'),
      agentFileText({ description: 'Reviews code.' }, 'You review code in ${cwd}.'),
      'utf-8',
    );

    const session = new Session({
      id: 'test-agentfile-main',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      kimiHomeDir: brandHome,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      agents: { userHomeDir: osHome, profileName: 'reviewer' },
    });
    try {
      const main = await session.createMain();
      expect(main.config.profileName).toBe('reviewer');
      expect(main.config.systemPrompt).toContain(`You review code in ${workDir}`);
      // The default delegation set includes the file-defined agent.
      expect(Object.keys(session.agentCatalog.delegatableSubagents('agent'))).toContain('reviewer');
    } finally {
      await session.close();
    }
  });

  it('fails createMain for an unknown profileName', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const brandHome = await makeTempDir();
    const session = new Session({
      id: 'test-agentfile-unknown',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      kimiHomeDir: brandHome,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      agents: { userHomeDir: brandHome, profileName: 'nope' },
    });
    try {
      await expect(session.createMain()).rejects.toThrow(/Agent profile "nope" was not found/);
    } finally {
      await session.close();
    }
  });

  it('fails createMain for an invalid explicit agent file', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const brandHome = await makeTempDir();
    const session = new Session({
      id: 'test-agentfile-fatal',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      kimiHomeDir: brandHome,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      agents: { userHomeDir: brandHome, explicitFiles: [join(workDir, 'missing.md')] },
    });
    try {
      await expect(session.createMain()).rejects.toThrow();
    } finally {
      // close() -> flushMetadata() awaits the same readiness gate, which
      // carries the fatal agentfile error too; production swallows it via
      // core-impl's `session.close().catch(() => {})` cleanup path.
      await session.close().catch(() => {});
    }
  });

  it('restores a bound custom subagent when its agent files are removed before resume', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const brandHome = await makeTempDir();
    const osHome = await makeTempDir();
    const agentDir = await makeTempDir();
    const leaderPath = join(agentDir, 'leader.md');
    const workerPath = join(agentDir, 'worker.md');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      leaderPath,
      agentFileText(
        { name: 'leader', description: 'Delegates focused work.', subagents: ['worker'] },
        'Delegate repository work only.',
      ),
      'utf-8',
    );
    await writeFile(
      workerPath,
      agentFileText(
        { name: 'worker', description: 'Performs focused work.', tools: ['Read'] },
        'Perform the delegated work.',
      ),
      'utf-8',
    );

    const options = {
      id: 'test-agentfile-delegation-resume',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      kimiHomeDir: brandHome,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      agents: {
        userHomeDir: osHome,
        profileName: 'leader',
        explicitFiles: [leaderPath, workerPath],
      },
    };
    const created = new Session(options);
    try {
      await created.createMain();
    } finally {
      await created.closeForReload();
    }

    await Promise.all([unlink(leaderPath), unlink(workerPath)]);

    const resumed = new Session({
      ...options,
      agents: { userHomeDir: osHome },
      initializeMainAgent: false,
    });
    try {
      await resumed.resume();
      const main = await resumed.ensureAgentResumed('main');
      const worker = main.subagentHost!.delegatableSubagents(main.config.profileName)['worker'];

      expect(worker).toMatchObject({
        name: 'worker',
        description: 'Performs focused work.',
        tools: ['Read'],
      });
    } finally {
      await resumed.close();
    }
  });
});
