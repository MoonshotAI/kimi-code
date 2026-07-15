import assert from 'node:assert/strict';

import { Klient } from '@moonshot-ai/klient';
import { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import {
  ISessionIndex,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import {
  IWorkspaceRegistry,
  type Workspace,
} from '@moonshot-ai/agent-core-v2/app/workspaceRegistry/workspaceRegistry';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
}

interface V1Workspace {
  readonly id: string;
  readonly root: string;
  readonly session_count: number;
}

interface V1Session {
  readonly id: string;
  readonly workspace_id: string;
  readonly metadata?: { readonly cwd?: string };
  readonly archived?: boolean;
}

interface V1Message {
  readonly id: string;
  readonly role: string;
  readonly content: readonly unknown[];
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

const baseUrl = (process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627').replace(/\/$/, '');
const token = optionalEnv('KIMI_SERVER_TOKEN');
const expectedSessionId = optionalEnv('KIMI_SMOKE_EXPECT_SESSION_ID');
const expectedCwd = optionalEnv('KIMI_SMOKE_EXPECT_CWD');
const marker = optionalEnv('KIMI_SMOKE_MARKER');
const requireHistory = /^(1|true|yes)$/i.test(process.env['KIMI_SMOKE_REQUIRE_HISTORY'] ?? 'false');

function authHeaders(): Headers {
  const result = new Headers();
  if (token !== undefined) result.set('authorization', `Bearer ${token}`);
  return result;
}

async function v1<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, { headers: authHeaders() });
  const envelope = (await response.json()) as Envelope<T>;
  assert.equal(response.ok, true, `v1 ${path} returned HTTP ${String(response.status)}`);
  assert.equal(envelope.code, 0, `v1 ${path}: ${String(envelope.code)} ${envelope.msg}`);
  return envelope.data;
}

function sortedStrings(values: Iterable<string>): readonly string[] {
  return [...values].toSorted((a, b) => a.localeCompare(b));
}

function canonicalPath(value: string): string {
  const slashed = value.replaceAll('\\', '/').replace(/\/+$/, '');
  const rooted = /^[A-Za-z]:$/.test(slashed) ? `${slashed}/` : slashed;
  return /^(?:[A-Za-z]:\/|\/\/)/.test(rooted) ? rooted.toLowerCase() : rooted;
}

function duplicates(values: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return sortedStrings([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

function diagnoseAliases(values: readonly string[]): readonly string[] {
  const groups = new Map<string, Set<string>>();
  for (const value of values) {
    const canonical = canonicalPath(value);
    const group = groups.get(canonical) ?? new Set<string>();
    group.add(value);
    groups.set(canonical, group);
  }
  return sortedStrings(
    [...groups.values()]
      .filter((group) => group.size > 1)
      .map((group) => sortedStrings(group).join(' <> ')),
  );
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('\n');
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['text'] === 'string') return record['text'];
    return Object.values(record).map(text).join('\n');
  }
  return '';
}

async function listAllV1Sessions(): Promise<readonly V1Session[]> {
  const items: V1Session[] = [];
  let beforeId: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ include_archive: 'true', page_size: '100' });
    if (beforeId !== undefined) query.set('before_id', beforeId);
    const page = await v1<{ readonly items: readonly V1Session[]; readonly has_more: boolean }>(
      `/sessions?${query.toString()}`,
    );
    items.push(...page.items);
    if (!page.has_more) return items;
    const next = page.items.at(-1)?.id;
    assert.ok(next !== undefined && next !== beforeId, 'v1 session pagination did not advance');
    beforeId = next;
  }
}

async function listAllV1Messages(sessionId: string): Promise<readonly V1Message[]> {
  const items: V1Message[] = [];
  let beforeId: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ page_size: '100' });
    if (beforeId !== undefined) query.set('before_id', beforeId);
    const page = await v1<{ readonly items: readonly V1Message[]; readonly has_more: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`,
    );
    items.push(...page.items);
    if (!page.has_more) return items;
    const next = page.items.at(-1)?.id;
    assert.ok(next !== undefined && next !== beforeId, 'v1 message pagination did not advance');
    beforeId = next;
  }
}

function selectColdSession(sessions: readonly SessionSummary[]): SessionSummary | undefined {
  if (expectedSessionId !== undefined) {
    const selected = sessions.find((session) => session.id === expectedSessionId);
    assert.ok(selected, `expected session ${expectedSessionId} is absent from the global index`);
    return selected;
  }
  if (expectedCwd !== undefined) {
    const canonicalExpected = canonicalPath(expectedCwd);
    const matches = sessions.filter(
      (session) => session.cwd !== undefined && canonicalPath(session.cwd) === canonicalExpected,
    );
    assert.equal(matches.length, 1, `expected cwd must identify exactly one session; found ${String(matches.length)}`);
    return matches[0];
  }
  return sessions[0];
}

function report(label: string, values: readonly string[]): void {
  console.log(`${label}: ${values.length === 0 ? 'none' : values.join(', ')}`);
}

async function main(): Promise<void> {
  console.log(`server: ${baseUrl}`);
  const client = new Klient({ url: baseUrl, token });
  const index = client.core(ISessionIndex);

  // This must be the first session operation: capture the durable global index
  // before any session-scoped call can materialize a cold session.
  const globalPage = await index.list({ includeArchived: true });
  const sessions = globalPage.items;
  assert.ok(Array.isArray(sessions), 'global ISessionIndex.list did not return items');
  if (requireHistory || expectedSessionId !== undefined || expectedCwd !== undefined || marker !== undefined) {
    assert.ok(sessions.length > 0, 'historical sessions are required but the global index is empty');
  }
  console.log(`global index before warm-up: ${String(sessions.length)} sessions`);
  const failures: string[] = [];

  // Regression probe: this intentionally fails while the v2 dispatcher only
  // looks up live scopes instead of resuming an indexed cold session.
  const cold = selectColdSession(sessions);
  if (cold !== undefined) {
    try {
      const metadata = await client.session(cold.id).service(ISessionMetadata).read();
      assert.equal(metadata.id, cold.id, 'cold ISessionMetadata.read returned the wrong session');
      assert.equal(metadata.cwd, cold.cwd, 'cold metadata cwd differs from the index');
      assert.equal(metadata.archived, cold.archived, 'cold metadata archived flag differs from the index');
      console.log(`PASS cold ISessionMetadata.read (${cold.id})`);
    } catch (error) {
      const message = `cold session ${cold.id} is globally indexed but unavailable through session scope: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(`FAIL ${message}`);
    }
  } else {
    console.log('SKIP cold metadata read (no history found)');
  }

  const registry = client.core(IWorkspaceRegistry);
  const workspaces = await registry.list();
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const workspaceIds = new Set([
    ...workspaces.map((workspace) => workspace.id),
    ...sessions.map((session) => session.workspaceId),
  ]);

  for (const workspaceId of workspaceIds) {
    const filtered = await index.list({ workspaceId, includeArchived: true });
    const workspaceSessions: readonly SessionSummary[] = sessions.filter(
      (session: SessionSummary) => session.workspaceId === workspaceId,
    );
    assert.deepEqual(
      filtered.items.map((session) => session.id).toSorted((a, b) => a.localeCompare(b)),
      workspaceSessions.map((session: SessionSummary) => session.id).toSorted((a, b) => a.localeCompare(b)),
      `workspace-filtered index mismatch for ${workspaceId}`,
    );
    const active = workspaceSessions.filter((session: SessionSummary) => !session.archived).length;
    assert.equal(await index.countActive(workspaceId), active, `countActive mismatch for ${workspaceId}`);
  }
  console.log(`PASS workspace-filtered list/countActive (${String(workspaceIds.size)} workspace ids)`);

  const [v1WorkspacePage, v1Sessions] = await Promise.all([
    v1<{ readonly items: readonly V1Workspace[] }>('/workspaces'),
    listAllV1Sessions(),
  ]);
  const v1Workspaces = v1WorkspacePage.items;
  assert.deepEqual(
    v1Workspaces.map((workspace) => workspace.id).toSorted((a, b) => a.localeCompare(b)),
    workspaces.map((workspace) => workspace.id).toSorted((a, b) => a.localeCompare(b)),
    'v1 and IWorkspaceRegistry workspace ids differ',
  );
  for (const workspace of v1Workspaces) {
    assert.equal(workspace.root, workspaceById.get(workspace.id)?.root, `v1 root mismatch for ${workspace.id}`);
    assert.equal(
      workspace.session_count,
      sessions.filter((session) => session.workspaceId === workspace.id).length,
      `v1 session_count mismatch for ${workspace.id}`,
    );
  }
  assert.deepEqual(
    v1Sessions.map((session) => session.id).toSorted((a, b) => a.localeCompare(b)),
    sessions.map((session) => session.id).toSorted((a, b) => a.localeCompare(b)),
    'v1 and ISessionIndex session ids differ',
  );
  console.log('PASS v1 workspace/session cross-check');

  const orphanIds = sessions
    .filter((session) => !workspaceById.has(session.workspaceId))
    .map((session) => session.id)
    .toSorted((a, b) => a.localeCompare(b));
  const allPaths = [
    ...workspaces.map((workspace: Workspace) => workspace.root),
    ...sessions.flatMap((session) => (session.cwd === undefined ? [] : [session.cwd])),
  ];
  const pathAliases = diagnoseAliases(allPaths);
  const duplicateIndexIds = duplicates(sessions.map((session) => session.id));
  const duplicateV1Ids = duplicates(v1Sessions.map((session) => session.id));
  const duplicateWorkspaceIds = duplicates(workspaces.map((workspace) => workspace.id));
  const duplicateWorkspaceRoots = duplicates(
    workspaces.map((workspace) => canonicalPath(workspace.root)),
  );
  report('orphan sessions', orphanIds);
  report('Windows/canonical path aliases', pathAliases);
  report('duplicate index session ids', duplicateIndexIds);
  report('duplicate v1 session ids', duplicateV1Ids);
  report('duplicate workspace ids', duplicateWorkspaceIds);
  report('duplicate canonical workspace roots', duplicateWorkspaceRoots);
  if (orphanIds.length > 0) failures.push(`orphan sessions: ${orphanIds.join(', ')}`);
  if (pathAliases.length > 0) failures.push(`Windows/canonical path aliases: ${pathAliases.join(', ')}`);
  if (duplicateIndexIds.length > 0) failures.push(`duplicate index session ids: ${duplicateIndexIds.join(', ')}`);
  if (duplicateV1Ids.length > 0) failures.push(`duplicate v1 session ids: ${duplicateV1Ids.join(', ')}`);
  if (duplicateWorkspaceIds.length > 0) failures.push(`duplicate workspace ids: ${duplicateWorkspaceIds.join(', ')}`);
  if (duplicateWorkspaceRoots.length > 0) {
    failures.push(`duplicate canonical workspace roots: ${duplicateWorkspaceRoots.join(', ')}`);
  }

  if (marker !== undefined) {
    assert.ok(cold, 'KIMI_SMOKE_MARKER requires a selected historical session');
    // The v1 read resumes the session first; only then query the materialized
    // agent scope. This avoids racing a cold v2 scope lookup against resume.
    const v1Messages = await listAllV1Messages(cold.id);
    const context = await Promise.resolve(
      client.session(cold.id).agent('main').service(IAgentContextMemoryService).get(),
    );
    const v1Matches = v1Messages.filter((message) => text(message.content).includes(marker));
    const contextMatches = context.filter((message) => text(message.content).includes(marker));
    assert.ok(v1Matches.length > 0, `marker ${JSON.stringify(marker)} absent from v1 messages`);
    assert.ok(contextMatches.length > 0, `marker ${JSON.stringify(marker)} absent from agent context`);
    assert.deepEqual(
      sortedStrings(v1Matches.map((message) => message.role)),
      sortedStrings(contextMatches.map((message) => message.role)),
      'marker message roles differ between v1 messages and agent context',
    );
    console.log(`PASS marker cross-check (${String(v1Matches.length)} matching messages)`);
  }

  if (failures.length > 0) {
    throw new Error(`history audit found ${String(failures.length)} issue(s):\n- ${failures.join('\n- ')}`);
  }
  console.log('HISTORY SMOKE PASSED');
}

try {
  await main();
} catch (error) {
  console.error('HISTORY SMOKE FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
