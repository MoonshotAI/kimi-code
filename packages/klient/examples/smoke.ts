import assert from 'node:assert/strict';

import { Klient, RPCError } from '@moonshot-ai/klient';
import { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentContextSizeService } from '@moonshot-ai/agent-core-v2/agent/contextSize/contextSize';
import { IAgentPermissionModeService } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import { IAgentToolRegistryService } from '@moonshot-ai/agent-core-v2/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { IWorkspaceRegistry } from '@moonshot-ai/agent-core-v2/app/workspaceRegistry/workspaceRegistry';
import { ISessionActivity } from '@moonshot-ai/agent-core-v2/session/sessionActivity/sessionActivity';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '@moonshot-ai/agent-core-v2/session/workspaceContext/workspaceContext';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly request_id?: string;
}

interface ChannelDescriptor {
  readonly name: string;
  readonly scope: 'app' | 'session' | 'agent';
  readonly methods: readonly { readonly name: string; readonly kind: string }[];
}

interface WireMessage {
  readonly role: string;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

const baseUrl = (process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627').replace(/\/$/, '');
const token = optionalEnv('KIMI_SERVER_TOKEN');
const model = optionalEnv('KIMI_SMOKE_MODEL');

function headers(extra?: RequestInit['headers'], authToken = token): Headers {
  const result = new Headers(extra);
  if (authToken !== undefined) result.set('authorization', `Bearer ${authToken}`);
  return result;
}

async function apiFetch<T>(
  version: 'v1' | 'v2',
  path: string,
  init: RequestInit = {},
  authToken = token,
): Promise<{ readonly response: Response; readonly envelope: Envelope<T> }> {
  const response = await fetch(`${baseUrl}/api/${version}${path}`, {
    ...init,
    headers: headers(init.headers, authToken),
  });
  const envelope = (await response.json()) as Envelope<T>;
  return { response, envelope };
}

async function v1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { response, envelope } = await apiFetch<T>('v1', path, init);
  assert.equal(response.ok, true, `v1 ${path} returned HTTP ${String(response.status)}`);
  assert.equal(envelope.code, 0, `v1 ${path}: ${String(envelope.code)} ${envelope.msg}`);
  return envelope.data;
}

async function v2<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { response, envelope } = await apiFetch<T>('v2', path, init);
  assert.equal(response.ok, true, `v2 ${path} returned HTTP ${String(response.status)}`);
  assert.equal(envelope.code, 0, `v2 ${path}: ${String(envelope.code)} ${envelope.msg}`);
  return envelope.data;
}

function textOf(messages: readonly WireMessage[]): string {
  return messages.flatMap((message) => message.content.map((part) => part.text ?? '')).join('\n');
}

async function waitForModelReply(sessionId: string, marker: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const page = await v1<{ readonly items: readonly WireMessage[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/messages?page_size=100`,
    );
    if (page.items.some((message) => message.role === 'assistant' && textOf([message]).includes(marker))) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`timed out waiting for model reply containing ${JSON.stringify(marker)}`);
}

async function expectRpcError(label: string, operation: () => Promise<unknown>, code: number): Promise<void> {
  try {
    await operation();
    assert.fail(`${label} unexpectedly succeeded`);
  } catch (error) {
    assert.ok(error instanceof RPCError, `${label} did not throw RPCError`);
    assert.equal(error.code, code, `${label} returned unexpected RPC code`);
  }
}

async function main(): Promise<void> {
  console.log(`server: ${baseUrl}`);
  console.log(`auth:   ${token === undefined ? 'not configured' : 'bearer token'}`);
  console.log(`model:  ${model ?? 'disabled (transport-only smoke)'}`);

  const channels = await v2<readonly ChannelDescriptor[]>('/channels');
  for (const expected of ['sessionIndex', 'sessionMetadata', 'agentContextMemoryService']) {
    assert.ok(channels.some((channel) => channel.name === expected), `missing v2 channel ${expected}`);
  }
  assert.ok(
    channels.find((channel) => channel.name === 'sessionIndex')?.methods.some((method) => method.name === 'list'),
    'sessionIndex.list is not exposed',
  );
  console.log(`PASS /api/v2/channels (${String(channels.length)} channels)`);

  if (token !== undefined) {
    const badAuth = await apiFetch<unknown>('v2', '/channels', {}, `${token}-invalid`);
    assert.ok(
      !badAuth.response.ok || badAuth.envelope.code !== 0,
      'an invalid bearer token unexpectedly accessed /api/v2/channels',
    );
    console.log('PASS invalid bearer token rejected');
  } else {
    console.log('SKIP invalid bearer token (KIMI_SERVER_TOKEN is unset)');
  }

  const client = new Klient({ url: baseUrl, token });
  const index = client.core(ISessionIndex);
  const initial = await index.list({ includeArchived: true });
  assert.ok(Array.isArray(initial.items), 'HTTP core sessionIndex.list did not return items');
  const workspaces = await client.core(IWorkspaceRegistry).list();
  assert.ok(Array.isArray(workspaces), 'HTTP core workspaceRegistry.list did not return an array');
  console.log(
    `PASS Klient HTTP core (${String(initial.items.length)} sessions, ${String(workspaces.length)} workspaces)`,
  );

  await expectRpcError(
    'unknown method',
    () => (index as unknown as { missingMethod(): Promise<unknown> }).missingMethod(),
    40001,
  );
  const wrongScope = await apiFetch<unknown>('v2', '/sessionMetadata/read', { method: 'POST' });
  assert.equal(wrongScope.envelope.code, 40001, 'session service at core scope must be rejected');
  console.log('PASS unknown method and wrong scope rejected');

  const cwd = process.env['KIMI_SMOKE_CWD'] ?? workspaces[0]?.root;
  assert.ok(
    cwd !== undefined,
    'no registered workspace; set KIMI_SMOKE_CWD to a directory on the server',
  );
  const created = await v1<{ readonly id: string }>('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Klient smoke session', metadata: { cwd } }),
  });
  const sessionId = created.id;
  assert.ok(sessionId.length > 0, 'v1 session creation returned an empty id');
  console.log(`created owned session ${sessionId} in ${cwd}`);

  try {
    const session = client.session(sessionId);
    const metadata = session.service(ISessionMetadata);
    const before = await metadata.read();
    assert.equal(before.id, sessionId);
    assert.equal(before.cwd, cwd);
    await metadata.setTitle('Klient smoke verified');
    const after = await metadata.read();
    assert.equal(after.title, 'Klient smoke verified');

    const activity = session.service(ISessionActivity);
    assert.equal(await Promise.resolve(activity.status()), 'idle');
    assert.equal(await Promise.resolve(activity.isIdle()), true);
    const workspace = session.service(ISessionWorkspaceContext);
    const resolvedCwd = await Promise.resolve(workspace.resolve('.'));
    assert.equal(await Promise.resolve(workspace.isWithin(resolvedCwd)), true);
    console.log('PASS Klient HTTP session metadata/activity/workspace');

    const agent = session.agent('main');
    const context = await Promise.resolve(agent.service(IAgentContextMemoryService).get());
    const tasks = await Promise.resolve(agent.service(IAgentTaskService).list(false, 20));
    const usage = await Promise.resolve(agent.service(IAgentUsageService).status());
    const contextSize = await Promise.resolve(agent.service(IAgentContextSizeService).get());
    const tools = await Promise.resolve(agent.service(IAgentToolRegistryService).list());
    const profile = await Promise.resolve(agent.service(IAgentProfileService).data());
    const permissionMode = await (
      agent.service(IAgentPermissionModeService) as unknown as { mode(): Promise<string> }
    ).mode();
    assert.ok(Array.isArray(context), 'HTTP agent context get did not return an array');
    assert.ok(Array.isArray(tasks), 'HTTP agent task list did not return an array');
    assert.ok(usage !== null && typeof usage === 'object', 'HTTP agent usage status is invalid');
    assert.equal(typeof contextSize.size, 'number');
    assert.ok(Array.isArray(tools), 'HTTP agent tool list did not return an array');
    assert.equal(typeof profile.cwd, 'string');
    assert.ok(['manual', 'auto', 'yolo'].includes(permissionMode));
    console.log('PASS Klient HTTP agent context/task/usage/profile/tools/permission');

    const ws = client.ws();
    let resolveEvent: (event: unknown) => void = () => {};
    const eventReceived = new Promise<unknown>((resolve) => {
      resolveEvent = resolve;
    });
    const listenErrors: unknown[] = [];
    const errorSubscription = ws.onDidListenError((error) => listenErrors.push(error));
    const subscription = ws.listen('events', resolveEvent);
    try {
      const wsIndex = await ws.core(ISessionIndex).get(sessionId);
      assert.equal(wsIndex?.id, sessionId);
      assert.equal(ws.state, 'open');
      const wsMeta = await ws.session(sessionId).service(ISessionMetadata).read();
      assert.equal(wsMeta.id, sessionId);
      const wsContext = await Promise.resolve(
        ws.session(sessionId).agent('main').service(IAgentContextMemoryService).get(),
      );
      assert.ok(Array.isArray(wsContext), 'WebSocket agent context get did not return an array');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      await v1(`/sessions/${encodeURIComponent(sessionId)}/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Klient smoke WebSocket event' }),
      });
      await Promise.race([
        eventReceived,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('timed out waiting for a WebSocket core event'));
          }, 5_000);
        }),
      ]);
      assert.deepEqual(listenErrors, [], 'WebSocket subscription reported an error');
    } finally {
      subscription.dispose();
      errorSubscription.dispose();
      ws.close();
    }
    console.log('PASS Klient WebSocket core/session/agent calls and event subscription');

    if (model !== undefined) {
      const marker = `KLlENT_SMOKE_${Date.now().toString(36)}`;
      await client
        .session(sessionId)
        .agent('main')
        .service(IAgentProfileService)
        .setModel(model);
      const submitted = await v1<{ readonly prompt_id: string }>(
        `/sessions/${encodeURIComponent(sessionId)}/prompts`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: [{ type: 'text', text: `Reply with exactly: ${marker}` }],
            model,
          }),
        },
      );
      assert.ok(submitted.prompt_id.length > 0, 'model prompt returned an empty prompt id');
      await waitForModelReply(sessionId, marker);
      console.log('PASS optional minimal model prompt');
    }
  } finally {
    const archived = await v1<{ readonly archived: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}:archive`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(archived.archived, true, 'owned smoke session was not archived');
    console.log('PASS owned session archived');
  }

  console.log('SMOKE PASSED');
}

try {
  await main();
} catch (error) {
  console.error('SMOKE FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
