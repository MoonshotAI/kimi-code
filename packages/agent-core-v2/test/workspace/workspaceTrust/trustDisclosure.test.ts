import { mkdtempSync } from 'node:fs';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { WorkspaceTrustDisclosureService } from '#/workspace/workspaceTrust/trustDisclosureService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';

import { stubLog } from '../../_base/log/stubs';

describe('WorkspaceTrustDisclosureService', () => {
  let homeDir: string;
  let workDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-trust-disclosure-home-'));
    workDir = mkdtempSync(join(tmpdir(), 'kimi-trust-disclosure-work-'));
  });

  afterEach(async () => {
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(workDir, { recursive: true, force: true }),
    ]);
  });

  function createService(overrides: {
    trusted?: boolean;
    skills?: IWorkspaceSkillCatalog;
    agentProfilesRegistry?: IAgentProfileRegistry;
    instructions?: IWorkspaceInstructionsService;
  } = {}): WorkspaceTrustDisclosureService {
    const fs = new HostFileSystem();
    const bootstrap = { homeDir, osHomeDir: homeDir } as IBootstrapService;
    const trust = {
      ready: Promise.resolve(),
      isTrusted: () => overrides.trusted ?? false,
    } as IWorkspaceTrust;
    const skills = overrides.skills ?? ({
      ready: Promise.resolve(),
      catalog: { listSkills: () => [] },
    } as unknown as IWorkspaceSkillCatalog);
    const agentProfilesLoader = { ready: Promise.resolve() } as IWorkspaceAgentProfileLoader;
    const agentProfilesRegistry = overrides.agentProfilesRegistry ?? ({
      entries: () => [],
    } as IAgentProfileRegistry);
    const instructions = overrides.instructions ?? ({
      ready: Promise.resolve(),
      snapshot: { agentsMd: undefined, agentsMdWarning: undefined, agentsMdPaths: [] },
    } as IWorkspaceInstructionsService);
    return new WorkspaceTrustDisclosureService(
      'test-workspace',
      { cwd: workDir } as IWorkspaceContext,
      fs,
      bootstrap,
      new FileProjectLocalConfigService(bootstrap, fs),
      trust,
      skills,
      agentProfilesLoader,
      agentProfilesRegistry,
      instructions,
      stubLog(),
    );
  }

  it('returns an empty activation when the workspace is trusted', async () => {
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'github-mcp' } } }),
      'utf-8',
    );
    const activation = await createService({ trusted: true }).describeGatedActivation();
    expect(activation).toEqual({
      mcpServers: [],
      additionalDirs: [],
      instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [] },
    });
  });

  it('describes project MCP servers with redacted keys and origin', async () => {
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'github-mcp', args: ['--safe'], env: { TOKEN: 'hidden' } },
          disabled: { command: 'never-runs', enabled: false },
          remote: {
            transport: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer x' },
            bearerTokenEnvVar: 'MCP_TOKEN',
          },
        },
      }),
      'utf-8',
    );
    await writeFile(
      join(homeDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { userOnly: { command: 'user-mcp' } } }),
      'utf-8',
    );
    const activation = await createService().describeGatedActivation();
    expect(activation.mcpServers).toEqual([
      {
        name: 'github',
        transport: 'stdio',
        command: 'github-mcp',
        args: ['--safe'],
        cwd: workDir,
        envKeys: ['TOKEN'],
        origin: join(workDir, '.mcp.json'),
      },
      {
        name: 'remote',
        transport: 'http',
        url: 'https://example.test/mcp',
        headerKeys: ['Authorization'],
        bearerTokenEnvVar: 'MCP_TOKEN',
        origin: join(workDir, '.mcp.json'),
      },
    ]);
    const serialized = JSON.stringify(activation);
    expect(serialized).not.toContain('hidden');
    expect(serialized).not.toContain('userOnly');
    expect(serialized).not.toContain('never-runs');
  });

  it('discloses additional dirs outside the project by real target', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'kimi-trust-disclosure-outside-'));
    const insideDir = join(workDir, 'sub');
    await mkdir(insideDir, { recursive: true });
    await symlink(outsideDir, join(workDir, 'linked-dir'), 'dir');
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = [${JSON.stringify(outsideDir)}, "sub", "linked-dir"]\n`,
      'utf-8',
    );
    try {
      const activation = await createService().describeGatedActivation();
      expect(activation.additionalDirs).toEqual([
        { path: outsideDir, realPath: await realpath(outsideDir) },
        {
          path: join(workDir, 'linked-dir'),
          realPath: await realpath(join(workDir, 'linked-dir')),
        },
      ]);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('collects project instruction sources', async () => {
    const skills = {
      ready: Promise.resolve(),
      catalog: {
        listSkills: () => [
          { name: 'deploy-prod', source: 'project' },
          { name: 'user-skill', source: 'user' },
        ],
      },
    } as unknown as IWorkspaceSkillCatalog;
    const agentProfilesRegistry = {
      entries: () => [
        {
          sourceId: 'workspace',
          priority: 0,
          workspaceKey: 'test-workspace',
          contribution: { profiles: [{ name: 'release-manager' }] },
        },
        {
          sourceId: 'workspace',
          priority: 0,
          workspaceKey: 'other-workspace',
          contribution: { profiles: [{ name: 'stranger' }] },
        },
        {
          sourceId: 'user',
          priority: 0,
          contribution: { profiles: [{ name: 'user-profile' }] },
        },
      ],
    } as unknown as IAgentProfileRegistry;
    const instructions = {
      ready: Promise.resolve(),
      snapshot: {
        agentsMd: undefined,
        agentsMdWarning: undefined,
        agentsMdPaths: [join(workDir, 'AGENTS.md'), join(homeDir, 'AGENTS.md')],
      },
    } as IWorkspaceInstructionsService;
    const activation = await createService({
      skills,
      agentProfilesRegistry,
      instructions,
    }).describeGatedActivation();
    expect(activation.instructionSources).toEqual({
      agentsMdPaths: [join(workDir, 'AGENTS.md')],
      skills: ['deploy-prod'],
      agentProfiles: ['release-manager'],
    });
  });

  it('degrades one section without failing the others', async () => {
    await writeFile(join(workDir, '.mcp.json'), '{not json', 'utf-8');
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    const outsideDir = mkdtempSync(join(tmpdir(), 'kimi-trust-disclosure-outside-'));
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = [${JSON.stringify(outsideDir)}]\n`,
      'utf-8',
    );
    try {
      const activation = await createService().describeGatedActivation();
      expect(activation.mcpServers).toEqual([]);
      expect(activation.additionalDirs).toEqual([
        { path: outsideDir, realPath: await realpath(outsideDir) },
      ]);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
