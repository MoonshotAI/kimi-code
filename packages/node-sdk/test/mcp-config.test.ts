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
import { TEST_IDENTITY } from './test-identity';

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

function definePrototypeNamedMcpServer(
  servers: Record<string, unknown>,
  url: string,
): Record<string, unknown> {
  Object.defineProperty(servers, '__proto__', {
    value: { transport: 'http', url },
    enumerable: true,
  });
  return servers;
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
        {
          name: 'global',
          transport: 'stdio',
          command: 'global-command',
          source: 'global',
          origin: join(homeDir, 'mcp.json'),
          mutable: true,
        },
      ]);
      // With `cwd`, the unified view adds the project layer as read-only
      // entries tagged with their defining file.
      await expect(harness.listMcpServers({ cwd: projectDir })).resolves.toEqual([
        {
          name: 'global',
          transport: 'stdio',
          command: 'global-command',
          source: 'global',
          origin: join(homeDir, 'mcp.json'),
          mutable: true,
        },
        {
          name: 'project',
          transport: 'stdio',
          command: 'project-command',
          cwd: projectDir,
          source: 'global',
          origin: join(projectDir, '.mcp.json'),
          mutable: false,
        },
      ]);
    } finally {
      await harness.close();
    }
  });

  it('resolves one managed entry by name', async () => {
    const homeDir = await makeTempDir();
    await writeMcpConfig(homeDir, {
      mcpServers: { docs: { command: 'docs-command' } },
    });
    const harness = createKimiHarness({ homeDir });

    try {
      await expect(harness.getMcpServer('docs')).resolves.toEqual({
        name: 'docs',
        transport: 'stdio',
        command: 'docs-command',
        source: 'global',
        origin: join(homeDir, 'mcp.json'),
        mutable: true,
      });
      await expect(harness.getMcpServer('missing')).rejects.toMatchObject({
        code: 'mcp.server_not_found',
      });
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
          source: 'global',
          origin: join(homeDir, 'mcp.json'),
          mutable: true,
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
        {
          name: 'keep',
          transport: 'stdio',
          command: 'keep-command',
          source: 'global',
          origin: join(homeDir, 'mcp.json'),
          mutable: true,
        },
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

  it('probes an inline config without persisting it', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir });

    try {
      await expect(
        harness.testMcpServerConfig({
          name: 'inline',
          transport: 'stdio',
          command: process.execPath,
          args: [stdioFixture],
        }),
      ).resolves.toMatchObject({
        success: true,
        output: expect.stringContaining('Available tools: 3'),
      });
      // The probe needed nothing on disk and wrote nothing.
      await expect(readFile(join(homeDir, 'mcp.json'), 'utf-8')).rejects.toMatchObject({
        code: 'ENOENT',
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

describe('session MCP servers (live session adds)', () => {
  it('adds a session-local server and reconnects it with a replacement config', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ workDir });
      // persist defaults to false: a session-local `caller` entry, nothing
      // written to the user-level file.
      const added = await session.addMcpServer({
        name: 'session-server',
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture],
      });
      expect(added).toMatchObject({
        name: 'session-server',
        transport: 'stdio',
        status: 'connected',
        toolCount: 3,
        source: 'caller',
      });
      await expect(readFile(join(homeDir, 'mcp.json'), 'utf-8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // The "name + full config" reconnect channel replaces the running
      // config — the narrowed tool filter shows up in the entry.
      await session.reconnectMcpServer('session-server', {
        name: 'session-server',
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture],
        enabledTools: ['echo'],
      });
      const narrowed = (await session.listMcpServers()).find(
        (server) => server.name === 'session-server',
      );
      expect(narrowed).toMatchObject({ status: 'connected', toolCount: 1, source: 'caller' });

      // persist: true also writes the user-level file and tags the entry
      // `global`.
      const persisted = await session.addMcpServer(
        {
          name: 'persisted',
          transport: 'stdio',
          command: process.execPath,
          args: [stdioFixture],
        },
        { persist: true },
      );
      expect(persisted).toMatchObject({ source: 'global', status: 'connected' });
      await expect(readMcpConfig(homeDir)).resolves.toEqual({
        mcpServers: {
          persisted: { transport: 'stdio', command: process.execPath, args: [stdioFixture] },
        },
      });
    } finally {
      await harness.close();
    }
  }, 20_000);
});

describe('MCP OAuth facade (host-controlled browser flow)', () => {
  it('merges global and plugin MCP entries without writing plugin entries to mcp.json', async () => {
    const homeDir = await makeTempDir();
    const pluginDir = await makeTempDir();
    const statusServer = await startMcpAuthStatusServer();
    await writeMcpConfig(homeDir, {
      mcpServers: { global: { transport: 'http', url: statusServer.plainUrl } },
    });
    await writeFile(
      join(pluginDir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'status-plugin',
        mcpServers: {
          remote: { transport: 'http', url: statusServer.oauthUrl, auth: 'oauth' },
        },
      }),
      'utf-8',
    );
    const harness = createKimiHarness({ homeDir });

    try {
      await harness.installPlugin(pluginDir);
      await expect(harness.inspectAppMcpServers()).resolves.toEqual([
        expect.objectContaining({
          serverId: 'global:global',
          locator: { source: 'global', name: 'global' },
          runtimeName: 'global',
          origin: 'global',
          editable: true,
          authStatus: 'not-applicable',
        }),
        expect.objectContaining({
          serverId: 'plugin:status-plugin:remote',
          locator: { source: 'plugin', pluginId: 'status-plugin', serverName: 'remote' },
          runtimeName: 'plugin-status-plugin:remote',
          origin: 'plugin',
          editable: false,
          enabled: true,
          authStatus: 'oauth-required',
        }),
      ]);
      expect(await readMcpConfig(homeDir)).toEqual({
        mcpServers: { global: { transport: 'http', url: statusServer.plainUrl } },
      });

      const collidingName = 'plugin-status-plugin:remote';
      // The management API rejects a user-level add shadowing the read-only
      // plugin entry, so the colliding runtime name is written directly: the
      // catalog keeps both entries and the name becomes ambiguous.
      await writeMcpConfig(homeDir, {
        mcpServers: {
          global: { transport: 'http', url: statusServer.plainUrl },
          [collidingName]: { transport: 'http', url: statusServer.oauthUrl, auth: 'oauth' },
        },
      });
      await expect(
        harness.inspectAppMcpServers([
          { source: 'plugin', pluginId: 'status-plugin', serverName: 'remote' },
        ]),
      ).resolves.toEqual([
        expect.objectContaining({
          runtimeName: collidingName,
          authStatus: 'unavailable',
          error: `MCP runtime name "${collidingName}" is not unique`,
        }),
      ]);

      await harness.setPluginMcpServerEnabled('status-plugin', 'remote', false);
      await expect(
        harness.inspectAppMcpServers([
          { source: 'plugin', pluginId: 'status-plugin', serverName: 'remote' },
        ]),
      ).resolves.toEqual([
        expect.objectContaining({
          enabled: false,
          authStatus: 'not-applicable',
        }),
      ]);
      // The colliding global entry is still enabled, so the shared runtime
      // name keeps locator-addressed OAuth operations ambiguous.
      await expect(
        harness.resetAppMcpServerAuth({
          source: 'plugin',
          pluginId: 'status-plugin',
          serverName: 'remote',
        }),
      ).rejects.toThrow('is shared by multiple enabled servers');
      // With the collision gone the plugin locator works again.
      await writeMcpConfig(homeDir, {
        mcpServers: { global: { transport: 'http', url: statusServer.plainUrl } },
      });
      await expect(
        harness.resetAppMcpServerAuth({
          source: 'plugin',
          pluginId: 'status-plugin',
          serverName: 'remote',
        }),
      ).resolves.toBeUndefined();
    } finally {
      await harness.close();
      await statusServer.close();
    }
  }, 15_000);

  it('reports authorization from a real MCP connection instead of token presence alone', async () => {
    const homeDir = await makeTempDir();
    const statusServer = await startMcpAuthStatusServer();
    const externalOAuth = new McpOAuthService({ kimiHomeDir: homeDir });
    await externalOAuth
      .getProvider('oauth-authorized', statusServer.oauthUrl)
      .saveTokens({ access_token: statusServer.authToken, token_type: 'Bearer' });
    await externalOAuth
      .getProvider('oauth-stale', statusServer.oauthUrl)
      .saveTokens({ access_token: 'stale-test-access-token', token_type: 'Bearer' });
    await writeMcpConfig(homeDir, {
      mcpServers: {
        stdio: { command: 'local-command' },
        plain: { transport: 'http', url: statusServer.plainUrl },
        detected: { transport: 'http', url: statusServer.oauthUrl },
        bearer: {
          transport: 'http',
          url: 'https://bearer.example.test/mcp',
          bearerTokenEnvVar: 'EXAMPLE_MCP_TOKEN',
        },
        'oauth-required': {
          transport: 'http',
          url: statusServer.oauthUrl,
          auth: 'oauth',
        },
        'oauth-authorized': {
          transport: 'http',
          url: statusServer.oauthUrl,
          auth: 'oauth',
        },
        'oauth-stale': {
          transport: 'http',
          url: statusServer.oauthUrl,
          auth: 'oauth',
        },
        'unavailable-explicit': {
          transport: 'http',
          url: statusServer.unavailableUrl,
          auth: 'oauth',
        },
        'unavailable-dynamic': {
          transport: 'http',
          url: statusServer.unavailableUrl,
        },
      },
    });
    const harness = createKimiHarness({ homeDir });

    try {
      await expect(
        harness
          .inspectAppMcpServers()
          .then((servers) =>
            servers.map(({ runtimeName: name, authStatus }) => ({ name, authStatus })),
          ),
      ).resolves.toEqual([
        { name: 'stdio', authStatus: 'not-applicable' },
        { name: 'plain', authStatus: 'not-applicable' },
        { name: 'detected', authStatus: 'oauth-required' },
        { name: 'bearer', authStatus: 'bearer-token' },
        { name: 'oauth-required', authStatus: 'oauth-required' },
        { name: 'oauth-authorized', authStatus: 'oauth-authorized' },
        // A stored grant the server rejects is a dead credential: re-login.
        { name: 'oauth-stale', authStatus: 'oauth-expired' },
        { name: 'unavailable-explicit', authStatus: 'unavailable' },
        { name: 'unavailable-dynamic', authStatus: 'unavailable' },
      ]);
    } finally {
      await harness.close();
      await statusServer.close();
    }
  }, 15_000);

  it('reports persisted authorization without starting an OAuth flow', async () => {
    const homeDir = await makeTempDir();
    const statusServer = await startMcpAuthStatusServer();
    const authorizedUrl = 'https://authorized.example.test/mcp';
    const externalOAuth = new McpOAuthService({ kimiHomeDir: homeDir });
    await externalOAuth
      .getProvider('oauth-authorized', authorizedUrl)
      .saveTokens({ access_token: 'test-access-token', token_type: 'Bearer' });
    await externalOAuth
      .getProvider('sse', statusServer.oauthUrl)
      .saveTokens({ access_token: 'stale-sse-token', token_type: 'Bearer' });
    await writeMcpConfig(homeDir, {
      mcpServers: definePrototypeNamedMcpServer(
        {
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
        statusServer.oauthUrl,
      ),
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
        { name: '__proto__', authStatus: 'oauth-required' },
      ]);
    } finally {
      await harness.close();
      await statusServer.close();
    }
  }, 15_000);

  it('settles a revoked grant as oauth-expired under online verification', async () => {
    const homeDir = await makeTempDir();
    const statusServer = await startMcpAuthStatusServer();
    const externalOAuth = new McpOAuthService({ kimiHomeDir: homeDir });
    // Stored but server-rejected: offline this reads as authorized; the
    // verify probe is what catches the dead grant.
    await externalOAuth
      .getProvider('oauth-stale', statusServer.oauthUrl)
      .saveTokens({ access_token: 'stale-test-access-token', token_type: 'Bearer' });
    await writeMcpConfig(homeDir, {
      mcpServers: {
        'oauth-stale': { transport: 'http', url: statusServer.oauthUrl, auth: 'oauth' },
      },
    });
    const harness = createKimiHarness({ homeDir });

    try {
      await expect(harness.listMcpServerAuthStatuses()).resolves.toEqual([
        { name: 'oauth-stale', authStatus: 'oauth-authorized' },
      ]);
      await expect(harness.listMcpServerAuthStatuses({ verify: true })).resolves.toEqual([
        { name: 'oauth-stale', authStatus: 'oauth-expired' },
      ]);
    } finally {
      await harness.close();
      await statusServer.close();
    }
  }, 15_000);

  it('distinguishes oauth-expired from recoverable grants offline', async () => {
    const homeDir = await makeTempDir();
    const expiredUrl = 'https://expired.example.test/mcp';
    const refreshableUrl = 'https://refreshable.example.test/mcp';
    const externalOAuth = new McpOAuthService({ kimiHomeDir: homeDir });
    // `expires_in: 0` with the save-time `obtained_at` stamp is already past
    // its absolute expiry by the time the status is computed.
    await externalOAuth.getProvider('expired', expiredUrl).saveTokens({
      access_token: 'expired-access-token',
      token_type: 'Bearer',
      expires_in: 0,
    });
    await externalOAuth.getProvider('refreshable', refreshableUrl).saveTokens({
      access_token: 'refreshable-access-token',
      token_type: 'Bearer',
      expires_in: 0,
      refresh_token: 'refresh-token',
    });
    await writeMcpConfig(homeDir, {
      mcpServers: {
        expired: { transport: 'http', url: expiredUrl, auth: 'oauth' },
        refreshable: { transport: 'http', url: refreshableUrl, auth: 'oauth' },
      },
    });
    const harness = createKimiHarness({ homeDir });

    try {
      // Offline: the refresh-token-less dead grant needs a re-login, while an
      // equally expired grant with a refresh token recovers on next connect.
      await expect(harness.listMcpServerAuthStatuses()).resolves.toEqual([
        { name: 'expired', authStatus: 'oauth-expired' },
        { name: 'refreshable', authStatus: 'oauth-authorized' },
      ]);
    } finally {
      await harness.close();
    }
  });

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
