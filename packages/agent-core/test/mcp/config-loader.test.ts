import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, KimiError } from '../../src/errors';
import { loadMcpServers, resolveMcpJsonPaths } from '../../src/mcp/config-loader';

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
  it('returns the canonical user and project paths', () => {
    const paths = resolveMcpJsonPaths({ cwd: '/work/proj', homeDir: '/home/user/.kimi-code' });
    expect(paths.user).toBe('/home/user/.kimi-code/mcp.json');
    expect(paths.project).toBe('/work/proj/.kimi-code/mcp.json');
  });
});

describe('loadMcpServers', () => {
  it('returns an empty map when no files exist', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers).toEqual({});
  });

  it('treats empty JSON files as empty maps', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeFile(join(home, 'mcp.json'), '   \n');
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers).toEqual({});
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

    const servers = await loadMcpServers({ cwd, homeDir: home });

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

  it('throws KimiError(config.invalid) on invalid JSON', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeFile(join(home, 'mcp.json'), '{not json}', 'utf-8');
    await expect(loadMcpServers({ cwd, homeDir: home })).rejects.toBeInstanceOf(KimiError);
    await expect(loadMcpServers({ cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws KimiError(config.invalid) on schema violation (unknown transport)', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'sse', url: 'https://x' } },
    });
    await expect(loadMcpServers({ cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws KimiError(config.invalid) on schema violation (missing required field)', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'stdio' } },
    });
    await expect(loadMcpServers({ cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
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
    const servers = await loadMcpServers({ cwd, homeDir: home });
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
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers['remote']).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com/sse',
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
      const servers = await loadMcpServers({ cwd });
      expect(servers['from_env']).toEqual({ transport: 'stdio', command: 'env-cmd' });
    } finally {
      if (saved === undefined) delete process.env['KIMI_CODE_HOME'];
      else process.env['KIMI_CODE_HOME'] = saved;
    }
  });
});
