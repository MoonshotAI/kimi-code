import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, Error2 } from '#/errors';
import {
  findMcpAnchor,
  loadAnchorMcpServers,
  loadMcpServers,
  loadMcpServersDetailed,
  loadUserMcpServers,
  resolveMcpJsonPaths,
  rootAnchor,
} from '#/app/mcpConfig/configLoader';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

const fs = new HostFileSystem();

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-mcp-loader-'));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf-8');
}

describe('resolveMcpJsonPaths', () => {
  it('returns the canonical user, project-root, and project-local paths', async () => {
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    const paths = await resolveMcpJsonPaths({ fs, cwd, homeDir: '/home/user/.kimi-code' });

    expect(paths.user).toBe('/home/user/.kimi-code/mcp.json');
    expect(paths.projectRoot).toBe(join(repoRoot, '.mcp.json'));
    expect(paths.project).toBe(join(cwd, '.kimi-code', 'mcp.json'));
  });

  it('stops the checkout lookup at an unparseable .git file instead of the enclosing repository', async () => {
    const repoRoot = makeTempDir();
    const vendored = join(repoRoot, 'vendor', 'lib');
    const cwd = join(vendored, 'src');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(vendored, '.git'), 'not a pointer\n');

    const paths = await resolveMcpJsonPaths({ fs, cwd });

    expect(paths.projectRoot).toBe(join(vendored, '.mcp.json'));
  });
});

describe('loadUserMcpServers', () => {
  it('reads only the user-level file and records its origin', async () => {
    const home = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { user: { command: 'user-cmd' }, toString: { url: 'https://example.com/mcp' } },
    });

    const loaded = await loadUserMcpServers({ fs, homeDir: home });

    expect(loaded.servers).toEqual({
      user: { transport: 'stdio', command: 'user-cmd' },
      toString: { transport: 'http', url: 'https://example.com/mcp' },
    });
    expect(loaded.origins).toEqual({
      user: join(home, 'mcp.json'),
      toString: join(home, 'mcp.json'),
    });
  });
});

describe('loadAnchorMcpServers', () => {
  async function writeProjectFiles(checkoutRoot: string, anchor: string): Promise<void> {
    await writeJson(join(checkoutRoot, '.mcp.json'), {
      mcpServers: {
        shared: { command: 'root-shared' },
        rootOnly: { command: 'root-only', cwd: 'tools' },
        remote: { url: 'https://example.com/mcp' },
      },
    });
    await writeJson(join(anchor, '.kimi-code', 'mcp.json'), {
      mcpServers: {
        shared: { command: 'anchor-shared' },
        anchorOnly: { command: 'anchor-only' },
      },
    });
  }

  it.each([
    ['a checkout root', (repoRoot: string) => repoRoot],
    ['a project root inside a checkout', (repoRoot: string) => join(repoRoot, 'packages', 'app')],
  ])('reads the same files as resolveMcpJsonPaths for %s', async (_label, anchorOf) => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const anchor = anchorOf(repoRoot);
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(anchor, { recursive: true });
    await writeJson(join(home, 'mcp.json'), { mcpServers: { userOnly: { command: 'user-only' } } });
    await writeProjectFiles(repoRoot, anchor);
    const paths = await resolveMcpJsonPaths({ fs, cwd: anchor, homeDir: home });

    const loaded = await loadAnchorMcpServers({ fs, anchor: rootAnchor(anchor) });

    expect(loaded.origins).toEqual({
      shared: paths.project,
      rootOnly: paths.projectRoot,
      remote: paths.projectRoot,
      anchorOnly: paths.project,
    });
    expect(loaded.servers).toEqual({
      shared: { transport: 'stdio', command: 'anchor-shared' },
      rootOnly: { transport: 'stdio', command: 'root-only', cwd: join(repoRoot, 'tools') },
      remote: { transport: 'http', url: 'https://example.com/mcp' },
      anchorOnly: { transport: 'stdio', command: 'anchor-only' },
    });
    const merged = await loadMcpServersDetailed({ fs, cwd: anchor, homeDir: home });
    expect(merged.servers).toEqual({ userOnly: { transport: 'stdio', command: 'user-only' }, ...loaded.servers });
  });

  it('reads both files at the anchor outside any checkout', async () => {
    const anchor = makeTempDir();
    await writeProjectFiles(anchor, anchor);

    const loaded = await loadAnchorMcpServers({ fs, anchor: rootAnchor(anchor) });

    expect(loaded.origins['rootOnly']).toBe(join(anchor, '.mcp.json'));
    expect(loaded.origins['anchorOnly']).toBe(join(anchor, '.kimi-code', 'mcp.json'));
    expect(loaded.servers['rootOnly']).toEqual({ transport: 'stdio', command: 'root-only', cwd: join(anchor, 'tools') });
  });
});

describe('findMcpAnchor', () => {
  async function project(): Promise<string> {
    const root = makeTempDir();
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    return root;
  }

  async function worktree(path: string): Promise<string> {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    return path;
  }

  it('anchors the project root and its plain subdirectories at the project root', async () => {
    const root = await project();
    const nested = join(root, 'node_modules', 'pkg');
    await mkdir(join(nested, '.kimi-code'), { recursive: true });

    await expect(findMcpAnchor(fs, root, { root, additionalDirs: [] })).resolves.toBe(root);
    await expect(findMcpAnchor(fs, nested, { root, additionalDirs: [] })).resolves.toBe(root);
  });

  it('anchors a checkout nested in the project at its checkout root', async () => {
    const root = await project();
    const wt = await worktree(join(root, '.worktrees', 'feature'));
    await mkdir(join(wt, 'src'), { recursive: true });

    await expect(findMcpAnchor(fs, wt, { root, additionalDirs: [] })).resolves.toBe(wt);
    await expect(findMcpAnchor(fs, join(wt, 'src'), { root, additionalDirs: [] })).resolves.toBe(wt);
  });

  it('stops at an unparseable .git file inside the project', async () => {
    const root = await project();
    const vendored = join(root, 'vendor', 'lib');
    await mkdir(join(vendored, 'src'), { recursive: true });
    await writeFile(join(vendored, '.git'), 'not a pointer\n');

    await expect(findMcpAnchor(fs, join(vendored, 'src'), { root, additionalDirs: [] })).resolves.toBe(vendored);
  });

  it('prefers a project root nested below the checkout root', async () => {
    const repoRoot = await project();
    const root = join(repoRoot, 'packages', 'app');
    await mkdir(join(root, 'src'), { recursive: true });

    await expect(findMcpAnchor(fs, join(root, 'src'), { root, additionalDirs: [] })).resolves.toBe(root);
  });

  it('anchors a checkout under a registered additional directory', async () => {
    const root = await project();
    const extra = await worktree(join(makeTempDir(), 'extra'));
    await mkdir(join(extra, 'src'), { recursive: true });

    await expect(findMcpAnchor(fs, join(extra, 'src'), { root, additionalDirs: [extra] })).resolves.toBe(extra);
  });

  it.each([
    ['a sibling checkout outside the project', async () => worktree(join(makeTempDir(), 'app-fix'))],
    ['a plain directory outside the project', async () => makeTempDir()],
  ])('falls back to the project root for %s', async (_label, outside) => {
    const root = await project();
    const dir = await outside();

    await expect(findMcpAnchor(fs, dir, { root, additionalDirs: [] })).resolves.toBe(root);
  });

  it('falls back to the project root when the checkout root lies above a registered additional directory', async () => {
    const root = await project();
    const repo = await project();
    const extra = join(repo, 'packages', 'lib');
    await mkdir(extra, { recursive: true });

    await expect(findMcpAnchor(fs, extra, { root, additionalDirs: [extra] })).resolves.toBe(root);
  });
});

describe('loadMcpServers', () => {
  it('returns an empty map when no files exist', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers).toEqual({});
  });

  it('treats empty JSON files as empty maps', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeFile(join(home, 'mcp.json'), '   \n');
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers).toEqual({});
  });

  it('rejects a null mcpServers field', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), { mcpServers: null });

    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('merges project-local mcp.json with user-global, project overriding on conflict', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();

    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-user' },
        userOnly: { transport: 'stdio', command: 'user-only' },
      },
    });
    await writeJson(join(cwd, '.kimi-code', 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-project' },
        local: { transport: 'http', url: 'http://localhost:8080/mcp' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home });

    expect(Object.keys(servers).toSorted()).toEqual(['local', 'shared', 'userOnly']);
    expect(servers['shared']).toEqual({
      transport: 'stdio',
      command: 'shared-project',
    });
    expect(servers['userOnly']).toEqual({
      transport: 'stdio',
      command: 'user-only',
    });
    expect(servers['local']).toEqual({
      transport: 'http',
      url: 'http://localhost:8080/mcp',
    });
  });

  it('loads only the user file when includeProject is false (untrusted workspace)', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-user' },
        userOnly: { transport: 'stdio', command: 'user-only' },
      },
    });
    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-root' },
        rootOnly: { command: 'root-only' },
      },
    });
    await writeJson(join(cwd, '.kimi-code', 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-project' },
        projectOnly: { transport: 'http', url: 'https://mcp.example.com' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home, includeProject: false });

    expect(Object.keys(servers).toSorted()).toEqual(['shared', 'userOnly']);
    expect(servers['shared']).toEqual({
      transport: 'stdio',
      command: 'shared-user',
    });
  });

  it('loads root .mcp.json from the repo root and lets project-local override it', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-user' },
        userOnly: { transport: 'stdio', command: 'user-only' },
      },
    });
    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-root' },
        rootOnly: { command: 'root-only' },
      },
    });
    await writeJson(join(cwd, '.kimi-code', 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-project' },
        projectOnly: { transport: 'http', url: 'https://mcp.example.com' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home });

    expect(Object.keys(servers).toSorted()).toEqual([
      'projectOnly',
      'rootOnly',
      'shared',
      'userOnly',
    ]);
    expect(servers['shared']).toEqual({
      transport: 'stdio',
      command: 'shared-project',
    });
    expect(servers['rootOnly']).toEqual({ transport: 'stdio', command: 'root-only', cwd: repoRoot });
    expect(servers['userOnly']).toEqual({ transport: 'stdio', command: 'user-only' });
    expect(servers['projectOnly']).toEqual({ transport: 'http', url: 'https://mcp.example.com' });
  });

  it('resolves project-root stdio cwd relative to the root .mcp.json directory', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        implicitRoot: { command: './bin/mcp-server' },
        explicitDot: { command: './bin/mcp-server', cwd: '.' },
        nested: { command: 'node', cwd: 'tools/mcp' },
        absolute: { command: 'node', cwd: '/tmp/mcp-workdir' },
        remote: { url: 'https://mcp.example.com' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home });

    expect(servers['implicitRoot']).toEqual({
      transport: 'stdio',
      command: './bin/mcp-server',
      cwd: repoRoot,
    });
    expect(servers['explicitDot']).toEqual({
      transport: 'stdio',
      command: './bin/mcp-server',
      cwd: repoRoot,
    });
    expect(servers['nested']).toEqual({
      transport: 'stdio',
      command: 'node',
      cwd: join(repoRoot, 'tools', 'mcp'),
    });
    expect(servers['absolute']).toEqual({
      transport: 'stdio',
      command: 'node',
      cwd: '/tmp/mcp-workdir',
    });
    expect(servers['remote']).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com',
    });
  });

  it('keeps Windows drive-letter and UNC stdio cwd values resolved on any host', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        drive: { command: 'node', cwd: 'C:/tools' },
        driveBackslash: { command: 'node', cwd: 'C:\\tools\\bin' },
        unc: { command: 'node', cwd: '//server/share/tools' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home });

    expect(servers['drive']).toMatchObject({ cwd: 'C:/tools' });
    expect(servers['driveBackslash']).toMatchObject({ cwd: 'C:/tools/bin' });
    expect(servers['unc']).toMatchObject({ cwd: '//server/share/tools' });
  });

  it('throws Error2(config.invalid) on invalid JSON', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeFile(join(home, 'mcp.json'), '{not json}', 'utf-8');
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toBeInstanceOf(Error2);
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws Error2(config.invalid) on schema violation with unknown transport', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'websocket', url: 'https://x.example.com' } },
    });
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws Error2(config.invalid) on schema violation with missing required field', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'stdio' } },
    });
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws Error2(config.invalid) when an MCP timeout exceeds the Node.js timer limit', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        bad: {
          transport: 'stdio',
          command: 'node',
          startupTimeoutMs: 2_147_483_648,
          toolTimeoutMs: 2_147_483_648,
        },
      },
    });
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('loads MCP timeouts at the Node.js timer upper boundary', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        boundary: {
          transport: 'stdio',
          command: 'node',
          startupTimeoutMs: 2_147_483_647,
          toolTimeoutMs: 2_147_483_647,
        },
      },
    });
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).resolves.toEqual({
      boundary: {
        transport: 'stdio',
        command: 'node',
        startupTimeoutMs: 2_147_483_647,
        toolTimeoutMs: 2_147_483_647,
      },
    });
  });

  it('infers transport=stdio when an entry omits transport but has command', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        gh: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    });
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers['gh']).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
  });

  it('infers transport=http when an entry omits transport but has url', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        remote: { url: 'https://mcp.example.com/sse' },
      },
    });
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers['remote']).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com/sse',
    });
  });

  it('loads explicit SSE server config', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        legacy: {
          transport: 'sse',
          url: 'https://mcp.example.com/sse',
          headers: { 'X-Tenant': 'kimi' },
          bearerTokenEnvVar: 'LEGACY_MCP_TOKEN',
        },
      },
    });
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers['legacy']).toEqual({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { 'X-Tenant': 'kimi' },
      bearerTokenEnvVar: 'LEGACY_MCP_TOKEN',
    });
  });

  it('honors KIMI_CODE_HOME env var when homeDir is not supplied', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { from_env: { transport: 'stdio', command: 'env-cmd' } },
    });
    const saved = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = home;
    try {
      const servers = await loadMcpServers({ fs, cwd });
      expect(servers['from_env']).toEqual({ transport: 'stdio', command: 'env-cmd' });
    } finally {
      if (saved === undefined) delete process.env['KIMI_CODE_HOME'];
      else process.env['KIMI_CODE_HOME'] = saved;
    }
  });
});
