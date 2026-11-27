import { isDeepStrictEqual } from 'node:util';

import { KapInvariantError, TestkitError, WaitTimeoutError } from '#/errors';
import { TIMEOUTS } from '#/fixtures/timeouts';
import { until } from '#/fixtures/wait';
import { isIdle, type KapClient } from '#/kap/client';
import type { KapFrame, KapItem, KapTurn } from '#/kap/frames';
import { KapEnvelopeError } from '#/kap/rest';
import type { KapSocket } from '#/kap/socket';
import type { KapPromptQueue, KapSession } from '#/kap/types';

const SESSION_STATE_FIELDS = ['activity', 'pending_interaction', 'last_turn_outcome', 'archived'] as const;

interface SessionState {
  readonly session: KapSession;
  readonly queue: KapPromptQueue;
}

interface Client {
  readonly socket: KapSocket;
  readonly label: string;
}

interface Deadline {
  remaining(): number;
}

export interface VerifyKapInvariantsOptions {
  readonly timeoutMs?: number;
}

export async function verifyKapInvariants(kap: KapClient, options: VerifyKapInvariantsOptions = {}): Promise<void> {
  const end = Date.now() + (options.timeoutMs ?? TIMEOUTS.wait);
  const deadline: Deadline = { remaining: () => Math.max(0, end - Date.now()) };
  const clients = kap.connectedSockets.map((socket, index) => ({ socket, label: `client #${index + 1}` }));
  const problems: string[] = [];
  for (const sessionId of sessionIdsOf(kap)) problems.push(...(await sessionProblems(kap, sessionId, clients, deadline)));
  for (const client of clients) problems.push(...interactionOrderProblems(client));
  if (problems.length > 0) throw new KapInvariantError(problems);
}

async function sessionProblems(kap: KapClient, sessionId: string, clients: readonly Client[], deadline: Deadline): Promise<string[]> {
  const settled = await settledState(kap, sessionId, deadline);
  if (settled === undefined) return [];
  if (typeof settled === 'string') return [settled];
  if (!isIdle(settled.session, settled.queue)) return [busyProblem(settled)];
  const open = clients.filter((client) => !client.socket.isClosed);
  const problems: string[] = [];
  for (const [agentId, turns] of await agentTurns(kap, sessionId, open)) {
    problems.push(...unfinishedProblems(sessionId, agentId, turns));
    for (const client of open.filter((candidate) => streamedAgents(candidate.socket, sessionId).includes(agentId))) {
      problems.push(...(await foldedTurnsProblems(client, sessionId, agentId, turns, deadline)));
    }
  }
  for (const client of open) problems.push(...(await sessionFrameProblems(client, settled.session, deadline)));
  return problems;
}

function sessionIdsOf(kap: KapClient): string[] {
  const ids = new Set(kap.createdSessionIds);
  for (const socket of kap.connectedSockets) {
    for (const frame of socket.frames) {
      const id = sessionIdOf(frame);
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids];
}

async function settledState(kap: KapClient, sessionId: string, deadline: Deadline): Promise<SessionState | string | undefined> {
  let last: SessionState | undefined;
  let failure: unknown;
  try {
    await until(`session ${sessionId} to settle`, async () => {
      try {
        last = await stateOf(kap, sessionId);
        failure = undefined;
      } catch (error) {
        failure = error;
        return false;
      }
      return last === undefined || isIdle(last.session, last.queue);
    }, { timeoutMs: deadline.remaining() });
  } catch (error) {
    if (!(error instanceof WaitTimeoutError)) throw error;
  }
  if (failure !== undefined) return `could not read the state of session ${sessionId}: ${failure instanceof Error ? failure.message : describe(failure)}`;
  return last;
}

async function stateOf(kap: KapClient, sessionId: string): Promise<SessionState | undefined> {
  try {
    const [session, queue] = await Promise.all([kap.session(sessionId), kap.prompts(sessionId)]);
    return { session, queue };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function busyProblem({ session, queue }: SessionState): string {
  return (
    `session ${session.id} is still busy when the test ends (activity ${session.activity}, pending interaction ${session.pending_interaction}, ` +
    `${queue.active === null ? 'no running prompt' : 'a running prompt'}, ${queue.queued.length} queued prompt(s)); ` +
    'wait for it, answer what it asks or stop it, including background work, before the test ends'
  );
}

async function agentTurns(kap: KapClient, sessionId: string, clients: readonly Client[]): Promise<Map<string, KapTurn[]>> {
  const found = new Map<string, KapTurn[]>();
  const queue = ['main', ...clients.flatMap((client) => streamedAgents(client.socket, sessionId))];
  for (let agentId = queue.shift(); agentId !== undefined; agentId = queue.shift()) {
    if (found.has(agentId)) continue;
    const turns = await restTurns(kap, sessionId, agentId);
    if (turns === undefined) continue;
    found.set(agentId, turns);
    queue.push(...turns.flatMap((turn) => turn.items.flatMap(childAgentIdsOf)));
  }
  return found;
}

function streamedAgents(socket: KapSocket, sessionId: string): readonly string[] {
  return [...socket.subscribedAgents(sessionId), ...socket.endedAgents(sessionId)];
}

function childAgentIdsOf(item: KapItem): string[] {
  const refs = item['agent_refs'];
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((ref: unknown) => {
    const id = (ref as { readonly agent_id?: unknown } | null)?.agent_id;
    return typeof id === 'string' ? [id] : [];
  });
}

async function restTurns(kap: KapClient, sessionId: string, agentId: string): Promise<KapTurn[] | undefined> {
  try {
    return await kap.turns(sessionId, agentId);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function unfinishedProblems(sessionId: string, agentId: string, turns: readonly KapTurn[]): string[] {
  return turns.flatMap((turn) => {
    const where = `turn ${turn.turn_id} of agent ${agentId} in session ${sessionId}`;
    const problems = turn['status'] === 'ended' ? [] : [`${where} is still ${describe(turn['status'])} after the session went idle`];
    for (const item of turn.items) {
      if (item['status'] !== undefined && item['status'] !== 'ended') {
        problems.push(`${item.type} item ${item.item_id} in ${where} is still ${describe(item['status'])} after the session went idle`);
      }
    }
    return problems;
  });
}

async function foldedTurnsProblems({ socket, label }: Client, sessionId: string, agentId: string, rest: readonly KapTurn[], deadline: Deadline): Promise<string[]> {
  const expected = (): readonly KapTurn[] => visibleTurns(socket, sessionId, agentId, rest);
  if (await catchesUp(socket, () => isDeepStrictEqual(socket.turns(sessionId, agentId), expected()), deadline)) return [];
  return [`${label} subscribed to agent ${agentId} of session ${sessionId} folds its frames into turns that differ from REST: ${firstDifference(socket.turns(sessionId, agentId), expected())}`];
}

function visibleTurns(socket: KapSocket, sessionId: string, agentId: string, rest: readonly KapTurn[]): readonly KapTurn[] {
  const snapshot = socket.conversation(sessionId, agentId).findLast((frame) => frame.type === 'turns');
  if (snapshot?.['has_more'] !== true) return rest;
  const first = (snapshot['turns'] as readonly KapTurn[] | undefined)?.[0]?.ordinal ?? Number.POSITIVE_INFINITY;
  const takenAt = Date.parse(describe(snapshot['event_created_at']));
  return rest.filter((turn) => turn.ordinal >= first || Date.parse(describe(turn['started_at'])) > takenAt);
}

async function sessionFrameProblems({ socket, label }: Client, session: KapSession, deadline: Deadline): Promise<string[]> {
  const latest = (): KapFrame | undefined => socket.frames.findLast((frame) => frame.type === 'session' && sessionIdOf(frame) === session.id);
  if (latest() === undefined) return [];
  const expected = stateFields(session);
  if (await catchesUp(socket, () => isDeepStrictEqual(stateFields(latest()?.['session']), expected), deadline)) return [];
  return [
    `${label}'s latest session frame for ${session.id} says ${JSON.stringify(stateFields(latest()?.['session']))}, but REST says ${JSON.stringify(expected)}`,
  ];
}

function interactionOrderProblems({ socket, label }: Client): string[] {
  const pending = new Map<string, Set<string>>();
  const problems: string[] = [];
  socket.frames.forEach((frame, index) => {
    for (const unsubscribed of socket.unsubscriptions) {
      if (unsubscribed.frame === index) pending.delete(unsubscribed.sessionId);
    }
    if (frame.type === 'interaction' && typeof frame['session_id'] === 'string') {
      const open = pending.get(frame['session_id']) ?? new Set<string>();
      if (frame['status'] === 'pending') open.add(String(frame['interaction_id']));
      else open.delete(String(frame['interaction_id']));
      pending.set(frame['session_id'], open);
      return;
    }
    if (frame.type !== 'session') return;
    const sessionId = sessionIdOf(frame);
    if (sessionId === undefined) return;
    if (frame['change'] === 'archived' || frame['change'] === 'deleted') {
      pending.delete(sessionId);
      return;
    }
    const open = pending.get(sessionId);
    const state = frame['session'] as { readonly pending_interaction?: unknown } | undefined;
    if (state?.pending_interaction === 'none' && open !== undefined && open.size > 0) {
      problems.push(
        `${label} received session frame #${index} for ${sessionId} saying nothing is pending while interaction ${[...open].join(', ')} was still pending; a client that trusts it drops the open approval or question`,
      );
    }
  });
  return problems;
}

async function catchesUp(socket: KapSocket, matches: () => boolean, deadline: Deadline): Promise<boolean> {
  if (matches()) return true;
  if (deadline.remaining() === 0) return false;
  try {
    await socket.waitFor(() => matches(), { after: socket.mark(), timeoutMs: deadline.remaining() });
    return true;
  } catch (error) {
    if (error instanceof TestkitError) return matches();
    throw error;
  }
}

function firstDifference(folded: readonly KapTurn[], rest: readonly KapTurn[]): string {
  if (folded.length !== rest.length) return `the client has ${folded.length} turn(s), REST has ${rest.length}`;
  const index = rest.findIndex((turn, position) => !isDeepStrictEqual(folded[position], turn));
  const [client, server] = [folded[index], rest[index]];
  if (client === undefined || server === undefined) return `turn #${index}`;
  const where = `turn ${server.turn_id}`;
  if (client.items.length !== server.items.length) return `${where}: the client has ${client.items.length} item(s), REST has ${server.items.length}`;
  const item = server.items.findIndex((candidate, position) => !isDeepStrictEqual(client.items[position], candidate));
  if (item !== -1) return `${where}, item ${server.items[item]?.item_id}: client ${excerpt(client.items[item])}, REST ${excerpt(server.items[item])}`;
  return `${where}: client ${excerpt(headerOf(client))}, REST ${excerpt(headerOf(server))}`;
}

function headerOf(turn: KapTurn): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(turn).filter(([key]) => key !== 'items'));
}

function stateFields(session: unknown): Readonly<Record<string, unknown>> {
  const fields: Readonly<Record<string, unknown>> = { pending_interaction: 'none', ...((session ?? {}) as Readonly<Record<string, unknown>>) };
  return Object.fromEntries(SESSION_STATE_FIELDS.filter((field) => fields[field] !== undefined).map((field) => [field, fields[field]]));
}

function sessionIdOf(frame: KapFrame): string | undefined {
  const id = frame.type === 'session' ? (frame['session'] as { readonly id?: unknown } | undefined)?.id : frame['session_id'];
  return typeof id === 'string' ? id : undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof KapEnvelopeError && (error.status === 404 || Math.trunc((error.code ?? 0) / 100) === 404);
}

function describe(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
}

function excerpt(value: unknown): string {
  return (JSON.stringify(value) ?? 'undefined').slice(0, 600);
}
