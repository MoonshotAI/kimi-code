/**
 * Scenario: v2 wiring MVP — the harness talks to the in-process agent-core-v2
 * engine (klient memory transport) instead of the v1 KimiCore RPC pair.
 * Responsibilities: `getExperimentalFeatures` is migrated end-to-end; every
 * not-yet-migrated method fails loudly with `not_implemented` instead of
 * silently hitting a v1 core.
 * Wiring: real v2 engine bootstrapped on a temp KIMI_CODE_HOME; remote provider calls are stubbed.
 * Run: pnpm exec vitest run test/sdk-rpc-client-v2.test.ts
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileTokenStorage,
  resolveKimiCodeOAuthRef,
  resolveKimiTokenStorageName,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKimiHarnessV2,
  ErrorCodes,
  KimiError,
  KimiHarness,
  removeProviderFromConfig,
  SDKRpcClientV2,
  type Event,
  type KimiConfig,
} from '#/index';
import { foldAgentWireReplay } from '#/v2/resume-replay';
import {
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  HostProcessError,
  IHostRequestHeaders,
  ISessionLifecycleHooks,
  ISessionLifecycleService,
  IWorkspaceLifecycleService,
  OsProcessErrors,
} from '@moonshot-ai/agent-core-v2';

import { McpOAuthService } from '../../agent-core/src/mcp/oauth/service';

import { TEST_IDENTITY } from './test-identity';
import { startMcpAuthStatusServer } from './mcp-auth-status-server';
import { recordingTelemetry, type TelemetryRecord } from './telemetry';

const hostEnvProbe = vi.hoisted(() => ({ failWithMissingShell: false }));

vi.mock('@moonshot-ai/agent-core-v2/_base/execEnv/environmentProbe', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@moonshot-ai/agent-core-v2/_base/execEnv/environmentProbe')
  >();
  return {
    ...actual,
    probeHostEnvironmentFromNode: () =>
      hostEnvProbe.failWithMissingShell
        ? Promise.reject(
            new actual.ProbeShellNotFoundError('Git Bash missing (stubbed)', [
              'C:\\Program Files\\Git\\bin\\bash.exe',
            ]),
          )
        : actual.probeHostEnvironmentFromNode(),
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  // The read-model mirror/query-store close asynchronously on dispose; await
  // the drains so the rm below never races their final flush (ENOTEMPTY).
  await drainSessionIndexMirror();
  await drainQueryStoreDisposals();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function stubProcessPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => {
    if (descriptor !== undefined) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  };
}

async function makeHarness(): Promise<{ harness: KimiHarness; homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
  tempDirs.push(homeDir);
  return { harness: createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY }), homeDir };
}

describe('SDKRpcClientV2 (agent-core-v2 wiring MVP)', () => {
  it('reports global MCP authorization from the persisted v2 credential store', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const statusServer = await startMcpAuthStatusServer();
    const authorizedUrl = 'https://authorized.example.test/mcp';
    const requiredUrl = 'https://required.example.test/mcp';
    const externalOAuth = new McpOAuthService({ kimiHomeDir: homeDir });
    await externalOAuth
      .getProvider('oauth-authorized', authorizedUrl)
      .saveTokens({ access_token: 'test-access-token', token_type: 'Bearer' });
    await externalOAuth
      .getProvider('sse', statusServer.oauthUrl)
      .saveTokens({ access_token: 'stale-sse-token', token_type: 'Bearer' });
    await writeFile(
      join(homeDir, 'mcp.json'),
      JSON.stringify({
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
            url: requiredUrl,
            auth: 'oauth',
          },
          'oauth-authorized': {
            transport: 'http',
            url: authorizedUrl,
            auth: 'oauth',
          },
        },
      }),
      'utf-8',
    );
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });

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

      await externalOAuth
        .getProvider('oauth-required', requiredUrl)
        .saveTokens({ access_token: 'new-test-access-token', token_type: 'Bearer' });
      await externalOAuth.invalidate('oauth-authorized', authorizedUrl, 'tokens');

      await expect(harness.listMcpServerAuthStatuses()).resolves.toEqual([
        { name: 'stdio', authStatus: 'not-applicable' },
        { name: 'plain', authStatus: 'not-applicable' },
        { name: 'detected', authStatus: 'oauth-required' },
        { name: 'sse', authStatus: 'not-applicable' },
        { name: 'sse-oauth', authStatus: 'oauth-required' },
        { name: 'bearer', authStatus: 'bearer-token' },
        { name: 'oauth-required', authStatus: 'oauth-authorized' },
        { name: 'oauth-authorized', authStatus: 'oauth-required' },
      ]);
    } finally {
      await harness.close();
      await statusServer.close();
    }
  }, 15_000);

  it('seeds the host request headers (User-Agent + X-Msh-*) into the engine', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      // Without this seed the managed vendors go out with the SDK's default
      // User-Agent and no X-Msh-* — the interactive-v2 path's identity bug.
      const headers = client.engineAccessor.get(IHostRequestHeaders).headers;
      expect(headers['User-Agent']).toBe(`kimi-code-cli/${TEST_IDENTITY.version}`);
      expect(headers['X-Msh-Platform']).toBe('kimi_code_cli');
      expect(headers['X-Msh-Version']).toBe(TEST_IDENTITY.version);
      expect(headers['X-Msh-Device-Id']).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it('surfaces a missing Git Bash probe failure during ensureConfigFile on Windows', async () => {
    hostEnvProbe.failWithMissingShell = true;
    const restorePlatform = stubProcessPlatform('win32');
    try {
      const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
      tempDirs.push(homeDir);
      const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
      try {
        await expect(harness.ensureConfigFile()).rejects.toBeInstanceOf(HostProcessError);
        await expect(harness.ensureConfigFile()).rejects.toMatchObject({
          code: OsProcessErrors.codes.SHELL_GIT_BASH_NOT_FOUND,
        });
      } finally {
        await harness.close();
      }
    } finally {
      hostEnvProbe.failWithMissingShell = false;
      restorePlatform();
    }
  });

  it('does not block ensureConfigFile on the host environment probe on POSIX', async () => {
    hostEnvProbe.failWithMissingShell = true;
    const restorePlatform = stubProcessPlatform('darwin');
    try {
      const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
      tempDirs.push(homeDir);
      const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
      try {
        await expect(harness.ensureConfigFile()).resolves.toBeUndefined();
      } finally {
        await harness.close();
      }
    } finally {
      hostEnvProbe.failWithMissingShell = false;
      restorePlatform();
    }
  });

  it('serves getExperimentalFeatures from the v2 engine', async () => {
    const { harness } = await makeHarness();
    try {
      const features = await harness.getExperimentalFeatures();
      expect(Array.isArray(features)).toBe(true);
      expect(features.length).toBeGreaterThan(0);
      for (const feature of features) {
        expect(typeof feature.id).toBe('string');
        expect(typeof feature.title).toBe('string');
        expect(typeof feature.env).toBe('string');
        expect(typeof feature.enabled).toBe('boolean');
        expect(typeof feature.defaultEnabled).toBe('boolean');
      }
    } finally {
      await harness.close();
    }
  });

  it('emits one complete metadata event when a generated title is applied', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const titleBaseUrl = 'https://api.example.test/coding/v1';
    const titleOAuthRef = resolveKimiCodeOAuthRef({ baseUrl: titleBaseUrl });
    // Storage names strip the `oauth/` prefix (FileTokenStorage rejects
    // namespaced keys); the engine resolves the same name when reading.
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ oauthKey: titleOAuthRef.key }),
      {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: '',
        tokenType: 'Bearer',
        expiresIn: 3600,
      },
    );
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "stub"

[experimental]
auto_session_title = true

[providers.stub]
type = "openai"
base_url = "https://model.example.test/v1"
api_key = "stub"

[models.stub]
provider = "stub"
model = "stub"
max_context_size = 1000

[providers."managed:kimi-code"]
type = "kimi"
base_url = "${titleBaseUrl}"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "${titleOAuthRef.key}"
`,
      'utf-8',
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://api.example.test/coding/v1/tools') {
        return new Response(JSON.stringify({ title: 'Generated title' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_generated_title_event', workDir });
      await session.importContext(
        'Generate a concise title for this session',
        "session 'source-session'",
      );
      await expect(
        harness.auth.getCachedAccessToken('managed:kimi-code', {
          storage: titleOAuthRef.storage,
          key: titleOAuthRef.key,
        }),
      ).resolves.toBe('test-access-token');
      await expect(session.getContext()).resolves.toMatchObject({
        history: [
          expect.objectContaining({
            role: 'user',
            origin: { kind: 'user' },
          }),
        ],
      });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        if (event.type === 'session.meta.updated' && event.title === 'Generated title') {
          events.push(event);
        }
      });

      await expect(harness.generateSessionTitle({ id: session.id })).resolves.toBe(
        'Generated title',
      );
      unsubscribe();

      expect(events).toEqual([
        expect.objectContaining({
          type: 'session.meta.updated',
          sessionId: session.id,
          agentId: 'main',
          title: 'Generated title',
          patch: { title: 'Generated title', isCustomTitle: false },
        }),
      ]);
    } finally {
      await harness.close();
      fetchSpy.mockRestore();
    }
  });

  it('serializes a temporary title-generation close against a public resume', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const titleBaseUrl = 'https://api.example.test/coding/v1';
    const titleOAuthRef = resolveKimiCodeOAuthRef({ baseUrl: titleBaseUrl });
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ oauthKey: titleOAuthRef.key }),
      {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: '',
        tokenType: 'Bearer',
        expiresIn: 3600,
      },
    );
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "stub"

[experimental]
auto_session_title = true

[providers.stub]
type = "openai"
base_url = "https://model.example.test/v1"
api_key = "stub"

[models.stub]
provider = "stub"
model = "stub"
max_context_size = 1000

[providers."managed:kimi-code"]
type = "kimi"
base_url = "${titleBaseUrl}"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "${titleOAuthRef.key}"
`,
      'utf-8',
    );
    let markFetchStarted!: () => void;
    let resolveFetch!: (response: Response) => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://api.example.test/coding/v1/tools') {
        markFetchStarted();
        return fetchResponse;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      await client.createSession({ id: 'ses_title_race', workDir });
      await client.importContext({
        sessionId: 'ses_title_race',
        content: 'Generate a concise title for this session',
        source: "session 'source-session'",
      });
      await client.closeSession({ sessionId: 'ses_title_race' });

      // The cold session is temporarily resumed for generation; block its
      // cleanup close inside the will-close hooks so the public resume below
      // lands while the close is still in flight.
      const titlePromise = client.generateSessionTitle({ id: 'ses_title_race' });
      await fetchStarted;
      const handler = await client.engineAccessor
        .get(IWorkspaceLifecycleService)
        .handlerFor({ root: workDir });
      const tempHandle = handler.accessor.get(ISessionLifecycleService).get('ses_title_race');
      expect(tempHandle).toBeDefined();
      let markCloseStarted!: () => void;
      let openCloseGate!: () => void;
      const closeStarted = new Promise<void>((resolve) => {
        markCloseStarted = resolve;
      });
      const closeGate = new Promise<void>((resolve) => {
        openCloseGate = resolve;
      });
      tempHandle!.accessor
        .get(ISessionLifecycleHooks)
        .onWillCloseSession.register('test-block', async (_event, next) => {
          markCloseStarted();
          await closeGate;
          await next();
        });

      resolveFetch(
        new Response(JSON.stringify({ title: 'Generated title' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await closeStarted;

      // The resume must queue behind the in-flight close instead of merging
      // into the handle that is being torn down.
      const order: string[] = [];
      const resumePromise = client.resumeSession({ id: 'ses_title_race' }).then((summary) => {
        order.push('resumed');
        return summary;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).toEqual([]);

      openCloseGate();
      await expect(titlePromise).resolves.toBe('Generated title');
      const summary = await resumePromise;
      expect(summary.id).toBe('ses_title_race');
      expect(order).toEqual(['resumed']);

      // The resumed session is a fresh, fully usable scope — not the handle
      // the temporary path just tore down.
      await client.renameSession({ id: 'ses_title_race', title: 'Resumed title' });
      const sessions = await client.listSessions({ workDir });
      expect(sessions.find((item) => item.id === 'ses_title_race')?.title).toBe('Resumed title');
    } finally {
      await client.close();
      fetchSpy.mockRestore();
    }
  });

  it('re-resumes a fresh session facade while the public close is in flight', async () => {
    const { harness } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);

    try {
      const session = await harness.createSession({ id: 'ses_resume_race', workDir });
      // close() flips `isClosed` synchronously; the engine close settles
      // asynchronously. The public resume must not hand back the closing
      // facade — it queues behind the close and materializes a fresh one.
      const closing = session.close();
      const resumed = await harness.resumeSession({ id: 'ses_resume_race' });
      await closing;

      expect(resumed).not.toBe(session);
      expect(session.isClosed).toBe(true);
      expect(resumed.isClosed).toBe(false);
      expect(resumed.getResumeState()).toBeTruthy();
      // The stale facade's late onClose must not evict the live session.
      expect(harness.getSession('ses_resume_race')).toBe(resumed);
    } finally {
      await harness.close();
    }
  });

  it('rejects one of two concurrent creates with the same explicit session id', async () => {
    const { harness } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);

    try {
      const [first, second] = await Promise.allSettled([
        harness.createSession({ id: 'ses_same_id', workDir }),
        harness.createSession({ id: 'ses_same_id', workDir }),
      ]);

      const outcomes = [first, second].map((result) => result.status);
      expect(outcomes.sort()).toEqual(['fulfilled', 'rejected']);
      const rejection = [first, second].find((result) => result.status === 'rejected');
      expect((rejection as PromiseRejectedResult).reason).toMatchObject({
        code: 'session.already_exists',
      });
      await expect(harness.resumeSession({ id: 'ses_same_id' })).resolves.toMatchObject({
        id: 'ses_same_id',
      });
    } finally {
      await harness.close();
    }
  });

  it('coalesces concurrent public resumes onto one session facade', async () => {
    const { harness } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);

    try {
      const session = await harness.createSession({ id: 'ses_coalesce', workDir });
      await session.close();

      const [first, second] = await Promise.all([
        harness.resumeSession({ id: 'ses_coalesce' }),
        harness.resumeSession({ id: 'ses_coalesce' }),
      ]);

      // One engine handle, one facade: a later close on either reference
      // must not strand a second live facade over the same handle.
      expect(first).toBe(second);
      expect(harness.getSession('ses_coalesce')).toBe(first);
    } finally {
      await harness.close();
    }
  });

  it('does not coalesce resumes with different options onto one facade', async () => {
    const { harness } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);

    try {
      const session = await harness.createSession({ id: 'ses_no_coalesce', workDir });
      await session.close();

      const [plain, withReplay] = await Promise.all([
        harness.resumeSession({ id: 'ses_no_coalesce' }),
        harness.resumeSession({ id: 'ses_no_coalesce', replayTurnLimit: 3 }),
      ]);

      // Different options must not be silently dropped onto the first
      // caller's facade — each gets its own resume.
      expect(plain).not.toBe(withReplay);
    } finally {
      await harness.close();
    }
  });

  it('reports the title state in the resumed summary', async () => {
    const { harness } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);

    try {
      const session = await harness.createSession({ id: 'ses_title_kind', workDir });
      await harness.renameSession({ id: session.id, title: '我的标题' });

      // The resumed summary is read off the live metadata document, so it
      // carries the canonical title state; the list path (index projection)
      // intentionally does not.
      await session.close();
      const resumed = await harness.resumeSession({ id: session.id });
      expect(resumed.summary?.titleKind).toBe('custom');
    } finally {
      await harness.close();
    }
  });

  it('serves listWorkspaceSkills through the engineAccessor escape hatch', async () => {
    const { harness, homeDir } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    await writeSkill(join(homeDir, 'skills', 'demo-user-skill'), 'demo-user-skill');
    await writeSkill(join(workDir, '.kimi-code', 'skills', 'demo-project-skill'), 'demo-project-skill');
    try {
      const skills = await harness.listWorkspaceSkills(workDir);
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      expect(byName.get('demo-user-skill')).toMatchObject({
        description: 'Skill demo-user-skill for the escape-hatch test',
        source: 'user',
      });
      expect(byName.get('demo-project-skill')).toMatchObject({
        description: 'Skill demo-project-skill for the escape-hatch test',
        source: 'project',
      });
    } finally {
      await harness.close();
    }
  });

  it('honors skillDirs (explicit dirs) over default user / project discovery', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const explicitBase = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-explicit-'));
    tempDirs.push(explicitBase);
    const explicitDir = join(explicitBase, 'skills');
    await writeSkill(join(homeDir, 'skills', 'demo-user-skill'), 'demo-user-skill');
    await writeSkill(join(workDir, '.kimi-code', 'skills', 'demo-project-skill'), 'demo-project-skill');
    await writeSkill(join(explicitDir, 'demo-explicit-skill'), 'demo-explicit-skill');
    const harness = createKimiHarnessV2({
      homeDir,
      identity: TEST_IDENTITY,
      skillDirs: [explicitDir],
    });
    try {
      const skills = await harness.listWorkspaceSkills(workDir);
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      expect(byName.get('demo-explicit-skill')).toMatchObject({
        description: 'Skill demo-explicit-skill for the escape-hatch test',
        source: 'user',
      });
      expect(byName.has('demo-user-skill')).toBe(false);
      expect(byName.has('demo-project-skill')).toBe(false);

      // The session skill catalog (the Skill tool's listing) goes through the
      // seeded engine runtime options, so it sees the same explicit source.
      const session = await harness.createSession({ workDir });
      const sessionNames = new Set((await session.listSkills()).map((skill) => skill.name));
      expect(sessionNames.has('demo-explicit-skill')).toBe(true);
      expect(sessionNames.has('demo-user-skill')).toBe(false);
      expect(sessionNames.has('demo-project-skill')).toBe(false);
      await session.close();
    } finally {
      await harness.close();
    }
  });

  it('serves the plugin catalog from the v2 engine on an empty home', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      expect(await rpc.listPlugins()).toEqual([]);
      expect(await rpc.reloadPlugins()).toEqual({ added: [], removed: [], errors: [] });
      await expect(rpc.getPluginInfo('missing-plugin')).rejects.toThrow();
    } finally {
      await rpc.close();
    }
  });

  it('persists removeProvider as one atomic cascade (providers, models, defaults)', async () => {
    const { harness } = await makeHarness();
    try {
      await harness.setConfig({
        providers: {
          a: { type: 'openai', baseUrl: 'https://a.example.test/v1', apiKey: 'sk-a' },
          b: { type: 'openai', baseUrl: 'https://b.example.test/v1', apiKey: 'sk-b' },
        },
        models: {
          'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
          'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
        },
        defaultModel: 'b/m1',
        defaultProvider: 'b',
      });
      const next = await harness.removeProvider('b');
      expect(next.providers['b']).toBeUndefined();
      expect(next.providers['a']).toBeDefined();
      expect(next.models?.['b/m1']).toBeUndefined();
      expect(next.models?.['a/m1']).toBeDefined();
      expect(next.defaultModel).toBeUndefined();
      expect(next.defaultProvider).toBeUndefined();
      // A fresh read from disk sees the same state — the cascade landed as a
      // single atomic write, never a halfway-removed intermediate.
      const reread = await harness.getConfig({ reload: true });
      expect(reread.providers['b']).toBeUndefined();
      expect(reread.models?.['b/m1']).toBeUndefined();
      expect(reread.defaultModel).toBeUndefined();
      expect(reread.defaultProvider).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('cascades removeProvider into the secondary_model pool', async () => {
    const { harness } = await makeHarness();
    try {
      await harness.setConfig({
        providers: {
          a: { type: 'openai', baseUrl: 'https://a.example.test/v1', apiKey: 'sk-a' },
          b: { type: 'openai', baseUrl: 'https://b.example.test/v1', apiKey: 'sk-b' },
        },
        models: {
          'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
          'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
        },
        secondaryModel: {
          defaultModel: 'a/m1',
          models: { 'a/m1': 'fast', 'b/m1': 'smart' },
        },
      });

      // Pool entries naming a removed model alias are filtered out; the
      // surviving default keeps the section valid.
      const filtered = await harness.removeProvider('b');
      expect(filtered.secondaryModel).toEqual({
        defaultModel: 'a/m1',
        models: { 'a/m1': 'fast' },
      });

      // When the pool's default dangles the whole section is dropped — a
      // leftover models table without its default would fail pool validation
      // on every session create.
      await harness.setConfig({
        secondaryModel: { defaultModel: 'a/m1', models: { 'a/m1': 'fast' } },
      });
      const cleared = await harness.removeProvider('a');
      expect(cleared.secondaryModel).toBeUndefined();
      const reread = await harness.getConfig({ reload: true });
      expect(reread.secondaryModel).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('replaces config sections atomically and clears undefined sections', async () => {
    const { harness } = await makeHarness();
    try {
      expect(harness.supportsAtomicSectionReplace()).toBe(true);
      await harness.setConfig({
        providers: { a: { type: 'openai', baseUrl: 'https://a.example.test/v1', apiKey: 'sk-a' } },
        models: { 'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 } },
        defaultModel: 'a/m1',
      });
      await harness.replaceConfigSections({ defaultModel: undefined });
      const next = await harness.getConfig({ reload: true });
      expect(next.defaultModel).toBeUndefined();
      // Sections absent from the write stay untouched.
      expect(next.providers['a']).toBeDefined();
      expect(next.models?.['a/m1']).toBeDefined();
    } finally {
      await harness.close();
    }
  });

  it('round-trips the secondaryModel pool field to the [secondary_model] config section', async () => {
    const { harness, homeDir } = await makeHarness();
    try {
      await harness.setConfig({
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap' },
        },
      });

      const toml = await readFile(join(homeDir, 'config.toml'), 'utf-8');
      expect(toml).toContain('[secondary_model]');
      expect(toml).toContain('default_model');
      expect(toml).toContain('[secondary_model.models]');
      expect(toml).not.toContain('[subagent.models]');

      const reread = await harness.getConfig({ reload: true });
      expect(reread.secondaryModel).toEqual({
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap' },
      });
    } finally {
      await harness.close();
    }
  });

  it('fails loudly with not_implemented for methods not yet migrated', async () => {
    const { harness } = await makeHarness();
    try {
      // `deleteSession` is the permanent case: the v2 engine has no
      // session-deletion capability, so it stays not_implemented by design
      // (tracked in `.tmp/v2-migration-tracker.md`).
      await expect(harness.deleteSession('session_missing')).rejects.toThrowError(KimiError);
      await expect(harness.deleteSession('session_missing')).rejects.toMatchObject({
        code: ErrorCodes.NOT_IMPLEMENTED,
      });
    } finally {
      await harness.close();
    }
  });
});

describe('SDKRpcClientV2 workspace trust', () => {
  it('reports an untrusted workspace with the project MCP servers it gates', async () => {
    const { harness } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'root-server': {
            command: 'root-cmd',
            args: ['--safe'],
            cwd: '/tmp/root',
            env: { SECRET: 'hidden' },
          },
          'http-server': {
            transport: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer hidden' },
            bearerTokenEnvVar: 'TOKEN',
          },
        },
      }),
      'utf-8',
    );
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'mcp.json'),
      JSON.stringify({ mcpServers: { 'nested-server': { command: 'nested-cmd' } } }),
      'utf-8',
    );
    try {
      const info = await harness.getWorkspaceTrustInfo(workDir);
      expect(info.trusted).toBe(false);
      expect(info.gatedMcpServers).toEqual([
        { name: 'http-server', transport: 'http', url: 'https://example.test/mcp' },
        { name: 'nested-server', transport: 'stdio', command: 'nested-cmd' },
        { name: 'root-server', transport: 'stdio', command: 'root-cmd', args: ['--safe'], cwd: '/tmp/root' },
      ]);
      const serialized = JSON.stringify(info);
      expect(serialized).not.toContain('hidden');
      expect(serialized).not.toContain('SECRET');
      expect(serialized).not.toContain('TOKEN');
    } finally {
      await harness.close();
    }
  });

  it('degrades the gated-server list to empty on an invalid project mcp.json', async () => {
    const { harness } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    await writeFile(join(workDir, '.mcp.json'), '{not json', 'utf-8');
    try {
      const info = await harness.getWorkspaceTrustInfo(workDir);
      expect(info).toEqual({ trusted: false, gatedMcpServers: [] });
    } finally {
      await harness.close();
    }
  });

  it('trustWorkspace flips the state and persists the marker in the kimi home', async () => {
    const { harness, homeDir } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    try {
      await harness.trustWorkspace(workDir);
      expect(await harness.getWorkspaceTrustInfo(workDir)).toEqual({
        trusted: true,
        gatedMcpServers: [],
      });
      // The trust marker lives in the kimi home, never in the checkout.
      const markers = await readdir(join(homeDir, 'workspace-trust'));
      expect(markers.length).toBe(1);
      expect(await readdir(workDir)).not.toContain('workspace-trust');
    } finally {
      await harness.close();
    }
  });
});

describe('foldAgentWireReplay', () => {
  it('folds a journal into v1 replay records and the tool store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-fold-'));
    tempDirs.push(dir);
    const wirePath = join(dir, 'wire.jsonl');
    const records = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1000 },
      {
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
        time: 1001,
      },
      { type: 'permission.set_mode', mode: 'auto', time: 1002 },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'old', status: 'done' }],
        time: 1003,
      },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'new', status: 'pending' }],
        time: 1004,
      },
      // A v2-only op the v1 restore switch does not know: ignored.
      { type: 'profile.bind', profileName: 'agent', systemPrompt: 'x', thinkingEffort: 'off', disallowedTools: [], time: 1005 },
    ];
    await writeFile(wirePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8');
    const folded = await foldAgentWireReplay(wirePath);
    expect(folded.replay).toEqual([
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
        time: 1001,
      },
      { type: 'permission_updated', mode: 'auto', time: 1002 },
    ]);
    // Last write wins per store key.
    expect(folded.toolStore).toEqual({ todo: [{ title: 'new', status: 'pending' }] });
  });

  it('degrades to an empty fold on a missing or corrupt journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-fold-'));
    tempDirs.push(dir);
    const empty = { replay: [], toolStore: {} };
    await expect(foldAgentWireReplay(join(dir, 'missing.jsonl'))).resolves.toEqual(empty);
    const emptyFile = join(dir, 'empty.jsonl');
    await writeFile(emptyFile, '', 'utf-8');
    await expect(foldAgentWireReplay(emptyFile)).resolves.toEqual(empty);
    const corrupt = join(dir, 'corrupt.jsonl');
    await writeFile(
      corrupt,
      '{"type":"metadata","protocol_version":"1.5","created_at":1}\n{not json\n{"type":"permission.set_mode","mode":"auto"}\n',
      'utf-8',
    );
    await expect(foldAgentWireReplay(corrupt)).resolves.toEqual(empty);
    // A truncated TAIL line is tolerated: everything before it still folds.
    const truncatedTail = join(dir, 'truncated.jsonl');
    await writeFile(
      truncatedTail,
      '{"type":"metadata","protocol_version":"1.5","created_at":1}\n{"type":"permission.set_mode","mode":"auto","time":2}\n{"type":"context.append_messa',
      'utf-8',
    );
    const folded = await foldAgentWireReplay(truncatedTail);
    expect(folded.replay).toEqual([{ type: 'permission_updated', mode: 'auto', time: 2 }]);
  });
});

describe('SDKRpcClientV2 engine telemetry', () => {
  it('forwards engine-side events to the host-supplied telemetry client', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-work-'));
    tempDirs.push(workDir);
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarnessV2({
      homeDir,
      identity: TEST_IDENTITY,
      telemetry: recordingTelemetry(records),
    });
    try {
      const session = await harness.createSession({ workDir });
      await session.setPermission('yolo');
      expect(records.some((record) => record.event === 'yolo_toggle')).toBe(true);
      await session.close();
    } finally {
      await harness.close();
    }
  });

  it('honors telemetry = false for engine-side events', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-off-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-off-work-'));
    tempDirs.push(workDir);
    await writeFile(join(homeDir, 'config.toml'), 'telemetry = false\n', 'utf-8');
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarnessV2({
      homeDir,
      identity: TEST_IDENTITY,
      telemetry: recordingTelemetry(records),
    });
    try {
      const session = await harness.createSession({ workDir });
      await session.setPermission('yolo');
      expect(records.some((record) => record.event === 'yolo_toggle')).toBe(false);
      await session.close();
    } finally {
      await harness.close();
    }
  });
});

describe('removeProviderFromConfig', () => {
  it('drops the provider, its models and dangling default pointers without mutating the input', () => {
    const config = {
      providers: {
        a: { type: 'openai', baseUrl: 'https://a.example.test/v1' },
        b: { type: 'openai', baseUrl: 'https://b.example.test/v1' },
      },
      models: {
        'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
        'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
        'my-b': { provider: 'b', model: 'm1', maxContextSize: 100 },
      },
      defaultModel: 'my-b',
      defaultProvider: 'b',
    } as unknown as KimiConfig;

    const next = removeProviderFromConfig(config, 'b');

    expect(Object.keys(next.providers)).toEqual(['a']);
    expect(Object.keys(next.models ?? {})).toEqual(['a/m1']);
    expect(next.defaultModel).toBeUndefined();
    expect(next.defaultProvider).toBeUndefined();
    // The input config is left untouched (the staging host threads the copy).
    expect(config.providers['b']).toBeDefined();
    expect(config.models?.['b/m1']).toBeDefined();
    expect(config.defaultModel).toBe('my-b');
  });

  it('keeps the default pointers when they do not dangle', () => {
    const config = {
      providers: {
        a: { type: 'openai' },
        b: { type: 'openai' },
      },
      models: {
        'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
        'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
      },
      defaultModel: 'a/m1',
      defaultProvider: 'a',
    } as unknown as KimiConfig;

    const next = removeProviderFromConfig(config, 'b');

    expect(Object.keys(next.providers)).toEqual(['a']);
    expect(Object.keys(next.models ?? {})).toEqual(['a/m1']);
    expect(next.defaultModel).toBe('a/m1');
    expect(next.defaultProvider).toBe('a');
  });

  it('filters secondary_model pool entries whose model alias was removed', () => {
    const config = {
      providers: { a: { type: 'openai' }, b: { type: 'openai' } },
      models: {
        'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
        'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
      },
      secondaryModel: {
        defaultModel: 'a/m1',
        models: { 'a/m1': 'fast', 'b/m1': 'smart' },
      },
    } as unknown as KimiConfig;

    const next = removeProviderFromConfig(config, 'b');

    expect(next.secondaryModel).toEqual({
      defaultModel: 'a/m1',
      models: { 'a/m1': 'fast' },
    });
  });

  it('drops the secondary_model section when its default model dangles', () => {
    const config = {
      providers: { a: { type: 'openai' }, b: { type: 'openai' } },
      models: {
        'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
        'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
      },
      secondaryModel: {
        defaultModel: 'b/m1',
        models: { 'a/m1': 'fast', 'b/m1': 'smart' },
      },
    } as unknown as KimiConfig;

    expect(removeProviderFromConfig(config, 'b').secondaryModel).toBeUndefined();

    // The legacy recipe's `model` key acts as the default fallback and
    // cascades the same way.
    const legacy = {
      ...config,
      secondaryModel: { model: 'b/m1', default_effort: 'low' },
    } as unknown as KimiConfig;
    expect(removeProviderFromConfig(legacy, 'b').secondaryModel).toBeUndefined();
  });

  it('leaves the secondary_model section untouched when nothing dangles', () => {
    const config = {
      providers: { a: { type: 'openai' }, b: { type: 'openai' } },
      models: {
        'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
        'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
      },
      secondaryModel: { defaultModel: 'a/m1' },
    } as unknown as KimiConfig;

    const next = removeProviderFromConfig(config, 'b');

    expect(next.secondaryModel).toEqual({ defaultModel: 'a/m1' });
  });
});

async function writeSkill(dir: string, name: string): Promise<void> {  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Skill ${name} for the escape-hatch test\n---\n\nBody of ${name}.\n`,
    'utf-8',
  );
}
