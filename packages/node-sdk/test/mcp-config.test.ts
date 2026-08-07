/**
 * Scenario: a host manages and checks user-global MCP servers without a session.
 * Responsibilities: global-only CRUD, safe malformed-file handling, standalone
 * connection checks, and host-driven OAuth URL/cancellation orchestration.
 * Wiring: real KimiHarness/Core/filesystem and stdio transport; only the OAuth
 * RPC boundary is stubbed so no external authorization service is contacted.
 * Run: pnpm exec vitest run packages/node-sdk/test/mcp-config.test.ts
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKimiHarness,
  KimiHarness,
  SDKRpcClientBase,
} from '#/index';
import { afterEach, describe, expect, it } from 'vitest';

import { McpOAuthService } from '../../agent-core/src/mcp/oauth/service';

import { startMcpAuthStatusServer } from './mcp-auth-status-server';

const tempDirs: string[] = [];
const stdioFixture = join(
  import.meta.dirname,
  '../../agent-core/test/mcp/fixtures/mock-stdio-server.mjs',
);

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-mcp-'));
  tempDirs.push(dir);
  return dir;
}

async function writeMcpConfig(homeDir: string, value: unknown): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  await writeFile(join(homeDir, 'mcp.json'), JSON.stringify(value), 'utf-8');
}

async function readMcpConfig(homeDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(homeDir, 'mcp.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('global MCP configuration (persisted user entries)', () => {
  it('lists only user-global servers when project config also exists', async () => {
    const homeDir = await makeTempDir();
    const projectDir = await makeTempDir();
    await writeMcpConfig(homeDir, {
      mcpServers: { global: { command: 'global-command' } },
    });
    await writeFile(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { project: { command: 'project-command' } } }),
      'utf-8',
    );
    const harness = createKimiHarness({ homeDir });

    try {
      await expect(harness.listMcpServers()).resolves.toEqual([
        { name: 'global', transport: 'stdio', command: 'global-command' },
      ]);
    } finally {
      await harness.close();
    }
  });

  it('preserves unrelated file content when a server is added', async () => {
    const homeDir = await makeTempDir();
    await writeMcpConfig(homeDir, {
      custom: { keep: true },
      mcpServers: { existing: { command: 'existing-command' } },
    });
    const harness = createKimiHarness({ homeDir });

    try {
      await harness.addMcpServer({
        name: 'added',
        transport: 'stdio',
        command: 'added-command',
      });

      await expect(readMcpConfig(homeDir)).resolves.toEqual({
        custom: { keep: true },
        mcpServers: {
          existing: { command: 'existing-command' },
          added: { transport: 'stdio', command: 'added-command' },
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('replaces the named entry when an existing server is updated', async () => {
    const homeDir = await makeTempDir();
    await writeMcpConfig(homeDir, {
      mcpServers: { docs: { command: 'old-command', args: ['old'] } },
    });
    const harness = createKimiHarness({ homeDir });

    try {
      await harness.updateMcpServer({
        name: 'docs',
        transport: 'http',
        url: 'https://example.test/mcp',
        auth: 'oauth',
      });

      await expect(harness.listMcpServers()).resolves.toEqual([
        {
          name: 'docs',
          transport: 'http',
          url: 'https://example.test/mcp',
          auth: 'oauth',
        },
      ]);
    } finally {
      await harness.close();
    }
  });

  it('removes only the named entry when a server is deleted', async () => {
    const homeDir = await makeTempDir();
    await writeMcpConfig(homeDir, {
      mcpServers: {
        remove: { command: 'remove-command' },
        keep: { command: 'keep-command' },
      },
    });
    const harness = createKimiHarness({ homeDir });

    try {
      await harness.removeMcpServer('remove');

      await expect(harness.listMcpServers()).resolves.toEqual([
        { name: 'keep', transport: 'stdio', command: 'keep-command' },
      ]);
    } finally {
      await harness.close();
    }
  });

  it('rejects a mutation when mcp.json is malformed without changing its bytes', async () => {
    const homeDir = await makeTempDir();
    const malformed = '{ not valid json';
    await writeFile(join(homeDir, 'mcp.json'), malformed, 'utf-8');
    const harness = createKimiHarness({ homeDir });

    try {
      await expect(
        harness.addMcpServer({
          name: 'unsafe',
          transport: 'stdio',
          command: 'unsafe-command',
        }),
      ).rejects.toMatchObject({ code: 'config.invalid' });
      await expect(readFile(join(homeDir, 'mcp.json'), 'utf-8')).resolves.toBe(malformed);
    } finally {
      await harness.close();
    }
  });
});

describe('standalone MCP check (connection result)', () => {
  it('reports discovered tools when a stdio server connects', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir });

    try {
      await harness.addMcpServer({
        name: 'working',
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture],
      });

      await expect(harness.testMcpServer('working')).resolves.toMatchObject({
        success: true,
        output: expect.stringContaining('Available tools: 3'),
      });
    } finally {
      await harness.close();
    }
  }, 15_000);

  it('returns a failed result when the stdio executable is missing', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir });

    try {
      await harness.addMcpServer({
        name: 'missing',
        transport: 'stdio',
        command: '/definitely/not/a/real/mcp-executable',
      });

      const result = await harness.testMcpServer('missing');

      expect(result.success).toBe(false);
      expect(result.output).toMatch(/ENOENT|not found|spawn/i);
    } finally {
      await harness.close();
    }
  });
});

describe('MCP OAuth facade (host-controlled browser flow)', () => {
  it('reports persisted authorization without starting an OAuth flow', async () => {
    const homeDir = await makeTempDir();
    const statusServer = await startMcpAuthStatusServer();
    const authorizedUrl = 'https://authorized.example.test/mcp';
    const externalOAuth = new McpOAuthService({ kimiHomeDir: homeDir });
    externalOAuth
      .getProvider('oauth-authorized', authorizedUrl)
      .saveTokens({ access_token: 'test-access-token', token_type: 'Bearer' });
    externalOAuth
      .getProvider('sse', statusServer.oauthUrl)
      .saveTokens({ access_token: 'stale-sse-token', token_type: 'Bearer' });
    await writeMcpConfig(homeDir, {
      mcpServers: {
        stdio: { command: 'local-command' },
        plain: { transport: 'http', url: statusServer.plainUrl },
        detected: { transport: 'http', url: statusServer.oauthUrl },
        sse: { transport: 'sse', url: statusServer.oauthUrl },
        'sse-oauth': { transport: 'sse', url: statusServer.oauthUrl, auth: 'oauth' },
        bearer: {
          transport: 'http',
          url: 'https://bearer.example.test/mcp',
          bearerTokenEnvVar: 'EXAMPLE_MCP_TOKEN',
        },
        'oauth-required': {
          transport: 'http',
          url: 'https://required.example.test/mcp',
          auth: 'oauth',
        },
        'oauth-authorized': {
          transport: 'http',
          url: authorizedUrl,
          auth: 'oauth',
        },
      },
    });
    const harness = createKimiHarness({ homeDir });

    try {
      await expect(harness.listMcpServerAuthStatuses()).resolves.toEqual([
        { name: 'stdio', authStatus: 'not-applicable' },
        { name: 'plain', authStatus: 'not-applicable' },
        { name: 'detected', authStatus: 'oauth-required' },
        { name: 'sse', authStatus: 'not-applicable' },
        { name: 'sse-oauth', authStatus: 'oauth-required' },
        { name: 'bearer', authStatus: 'bearer-token' },
        { name: 'oauth-required', authStatus: 'oauth-required' },
        { name: 'oauth-authorized', authStatus: 'oauth-authorized' },
      ]);
    } finally {
      await harness.close();
      await statusServer.close();
    }
  }, 15_000);

  it('resets authorization for a configured remote server', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir });

    try {
      await harness.addMcpServer({
        name: 'remote',
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        auth: 'oauth',
      });

      await expect(harness.resetMcpServerAuth('remote')).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('rejects authorization when the configured server uses stdio', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir });

    try {
      await harness.addMcpServer({
        name: 'local',
        transport: 'stdio',
        command: process.execPath,
      });

      await expect(
        harness.authenticateMcpServer('local', { onAuthorizationUrl: () => undefined }),
      ).rejects.toMatchObject({ code: 'request.invalid' });
    } finally {
      await harness.close();
    }
  });

  it('completes the flow after the host receives the authorization URL', async () => {
    const rpc = new OAuthRpc();
    const harness = oauthHarness(rpc);
    const urls: string[] = [];

    try {
      await harness.authenticateMcpServer('remote', {
        onAuthorizationUrl: (url) => {
          urls.push(url);
        },
      });

      expect(urls).toEqual(['https://auth.example.test/authorize?state=test']);
      expect(rpc.completedFlowIds).toEqual(['flow_test']);
    } finally {
      await harness.close();
    }
  });

  it('cancels the core flow when the host aborts OAuth authorization', async () => {
    const rpc = new OAuthRpc();
    const harness = oauthHarness(rpc);
    const controller = new AbortController();

    try {
      await expect(
        harness.authenticateMcpServer('remote', {
          onAuthorizationUrl: () => {
            controller.abort(new Error('OAuth authorization cancelled by user'));
          },
          signal: controller.signal,
        }),
      ).rejects.toThrow('OAuth authorization cancelled by user');
      expect(rpc.cancelledFlowIds).toEqual(['flow_test']);
    } finally {
      await harness.close();
    }
  });
});

class OAuthRpc extends SDKRpcClientBase {
  readonly completedFlowIds: string[] = [];
  readonly cancelledFlowIds: string[] = [];

  protected async getRpc(): Promise<never> {
    throw new Error('not used');
  }

  override async beginGlobalMcpServerAuth() {
    return {
      status: 'authorization-required' as const,
      flowId: 'flow_test',
      authorizationUrl: 'https://auth.example.test/authorize?state=test',
    };
  }

  override async completeGlobalMcpServerAuth(
    input: { readonly flowId: string },
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.completedFlowIds.push(input.flowId);
  }

  override async cancelGlobalMcpServerAuth(flowId: string): Promise<void> {
    this.cancelledFlowIds.push(flowId);
  }
}

function oauthHarness(rpc: OAuthRpc): KimiHarness {
  return new KimiHarness(rpc, {
    homeDir: '/tmp/kimi-sdk-mcp-oauth-home',
    configPath: '/tmp/kimi-sdk-mcp-oauth-home/config.toml',
    auth: {} as never,
    telemetry: { track: () => undefined },
    ensureConfigFile: async () => undefined,
    onClose: async () => undefined,
  });
}
