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
  let outsideDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-trust-disclosure-home-'));
    workDir = mkdtempSync(join(tmpdir(), 'kimi-trust-disclosure-work-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'kimi-trust-disclosure-outside-'));
  });

  afterEach(async () => {
    await Promise.all(
      [homeDir, workDir, outsideDir].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function createService(overrides: {
    trusted?: boolean;
    skills?: IWorkspaceSkillCatalog;
    agentProfilesRegistry?: IAgentProfileRegistry;
    instructions?: IWorkspaceInstructionsService;
  } = {}): WorkspaceTrustDisclosureService {
    const fs = new HostFileSystem();
    const bootstrap = { homeDir, osHomeDir: homeDir } as unknown as IBootstrapService;
    return new WorkspaceTrustDisclosureService(
      { cwd: workDir, workspaceId: 'test-workspace' } as unknown as IWorkspaceContext,
      fs,
      bootstrap,
      new FileProjectLocalConfigService(bootstrap, fs),
      { ready: Promise.resolve(), isTrusted: () => overrides.trusted ?? false } as unknown as IWorkspaceTrust,
      overrides.skills ??
        ({ ready: Promise.resolve(), catalog: { listSkills: () => [] } } as unknown as IWorkspaceSkillCatalog),
      { ready: Promise.resolve() } as unknown as IWorkspaceAgentProfileLoader,
      overrides.agentProfilesRegistry ?? ({ entries: () => [] } as unknown as IAgentProfileRegistry),
      overrides.instructions ??
        ({
          ready: Promise.resolve(),
          snapshot: { agentsMd: undefined, agentsMdWarning: undefined, agentsMdPaths: [] },
        } as unknown as IWorkspaceInstructionsService),
      stubLog(),
    );
  }

  it('returns an empty activation when the workspace is trusted', async () => {
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'github-mcp' } } }),
      'utf-8',
    );
    expect(await createService({ trusted: true }).describeGatedActivation()).toEqual({
      mcpServers: [],
      additionalDirs: [],
      instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [] },
    });
  });

  it('describes gated MCP servers, outside dirs, and instruction sources', async () => {
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'github-mcp', env: { TOKEN: 'hidden' } },
          disabled: { command: 'never-runs', enabled: false },
          remote: { transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
        },
      }),
      'utf-8',
    );
    await writeFile(
      join(homeDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { userOnly: { command: 'user-mcp' } } }),
      'utf-8',
    );
    const insideDir = join(workDir, 'sub');
    await mkdir(insideDir, { recursive: true });
    await symlink(outsideDir, join(workDir, 'linked-dir'), 'dir');
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = [${JSON.stringify(outsideDir)}, "sub", "linked-dir"]\n`,
      'utf-8',
    );
    const activation = await createService({
      skills: {
        ready: Promise.resolve(),
        catalog: {
          listSkills: () => [
            { name: 'deploy-prod', source: 'project' },
            { name: 'user-skill', source: 'user' },
          ],
        },
      } as unknown as IWorkspaceSkillCatalog,
      agentProfilesRegistry: {
        entries: () => [
          { sourceId: 'builtin', priority: -1, contribution: { profiles: [{ name: 'clash' }] } },
          { sourceId: 'explicit', priority: 10, contribution: { profiles: [{ name: 'outranked' }] } },
          {
            sourceId: 'workspace',
            priority: 0,
            workspaceKey: 'test-workspace',
            contribution: { profiles: [{ name: 'release-manager' }, { name: 'clash' }, { name: 'outranked' }] },
          },
          { sourceId: 'workspace', priority: 0, workspaceKey: 'other-workspace', contribution: { profiles: [{ name: 'stranger' }] } },
          { sourceId: 'user', priority: 0, contribution: { profiles: [{ name: 'user-profile' }] } },
        ],
      } as unknown as IAgentProfileRegistry,
      instructions: {
        ready: Promise.resolve(),
        snapshot: {
          agentsMd: undefined,
          agentsMdWarning: undefined,
          agentsMdPaths: [join(workDir, 'AGENTS.md'), join(homeDir, 'AGENTS.md')],
        },
      } as unknown as IWorkspaceInstructionsService,
    }).describeGatedActivation();
    expect(activation).toEqual({
      mcpServers: [
        {
          name: 'github',
          transport: 'stdio',
          command: 'github-mcp',
          args: undefined,
          cwd: workDir,
          envKeys: ['TOKEN'],
          origin: join(workDir, '.mcp.json'),
        },
        {
          name: 'remote',
          transport: 'http',
          url: 'https://example.test/mcp',
          headerKeys: ['Authorization'],
          bearerTokenEnvVar: undefined,
          origin: join(workDir, '.mcp.json'),
        },
      ],
      additionalDirs: [
        { path: outsideDir, realPath: await realpath(outsideDir) },
        { path: join(workDir, 'linked-dir'), realPath: await realpath(join(workDir, 'linked-dir')) },
      ],
      instructionSources: {
        agentsMdPaths: [join(workDir, 'AGENTS.md')],
        skills: ['deploy-prod'],
        agentProfiles: ['release-manager'],
      },
    });
    const serialized = JSON.stringify(activation);
    expect(serialized).not.toContain('hidden');
    expect(serialized).not.toContain('userOnly');
    expect(serialized).not.toContain('never-runs');
  });

  it('degrades one section without failing the others', async () => {
    await writeFile(join(workDir, '.mcp.json'), '{not json', 'utf-8');
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = [${JSON.stringify(outsideDir)}]\n`,
      'utf-8',
    );
    const activation = await createService().describeGatedActivation();
    expect(activation.mcpServers).toEqual([]);
    expect(activation.additionalDirs).toEqual([
      { path: outsideDir, realPath: await realpath(outsideDir) },
    ]);
  });
});
