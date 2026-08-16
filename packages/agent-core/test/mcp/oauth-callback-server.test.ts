/**
 * Scenario: lifecycle completion for the localhost MCP OAuth callback listener.
 * Responsibilities: closing rejects pending waits, successful callbacks survive cleanup, and
 * service cancellation settles in-flight completion. The listener and service are real; only the
 * external MCP SDK authorization boundary is mocked.
 * Run: pnpm --filter @moonshot-ai/agent-core exec vitest run test/mcp/oauth-callback-server.test.ts
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BeginAuthorizationResult,
  type CallbackServer,
  JsonFileStore,
  McpOAuthService,
  OAuthCallbackClosedError,
  startCallbackServer,
} from '../../src/mcp/oauth';

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/sdk/client/auth.js')>()),
  auth: vi.fn(),
}));

describe('OAuth callback server', () => {
  let server: CallbackServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('rejects a pending callback wait with a closed error when explicitly closed', async () => {
    server = await startCallbackServer();
    const pending = server.waitForCode({ timeoutMs: 60_000 });
    const rejection = expect(pending).rejects.toBeInstanceOf(OAuthCallbackClosedError);

    await server.close();

    await rejection;
  });

  it('delivers the callback payload when success closes the listener', async () => {
    server = await startCallbackServer();
    const pending = server.waitForCode({ timeoutMs: 60_000 });

    await fetch(`${server.redirectUri}?code=code-1&state=state-1`);

    await expect(pending).resolves.toEqual({ code: 'code-1', state: 'state-1' });
  });
});

describe('McpOAuthService cancellation', () => {
  let dir: string;
  let flow: BeginAuthorizationResult | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-mcp-oauth-cancel-'));
    vi.mocked(auth).mockImplementation(async (provider) => {
      await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
      return 'REDIRECT';
    });
  });

  afterEach(async () => {
    await flow?.cancel();
    flow = undefined;
    await rm(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('rejects an in-flight completion when the authorization flow is cancelled', async () => {
    const service = new McpOAuthService({ store: new JsonFileStore(dir) });
    flow = await service.beginAuthorization('example', 'https://mcp.example.test/rpc');
    const completion = flow.complete({ timeoutMs: 60_000 });
    const rejection = expect(completion).rejects.toThrow('OAuth callback listener closed');

    await flow.cancel();

    await rejection;
  });
});
