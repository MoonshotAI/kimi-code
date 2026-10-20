import { shallowReactive } from '@vue/reactivity';

import type { BlobStore } from '#/blob/index';
import {
  createLoop,
  loopProjection,
  toLoopRecord,
  type CreateLoopOptions,
  type Loop,
  type LoopProfile,
  type LoopRecord,
  type LoopRecordState,
  type TurnOutcome,
} from '#/loop/index';
import { openWriter, type Journal, type Log, type View } from '#/store/index';

import {
  AGENT_LOG_PREFIX,
  SESSION_LOG,
  sessionProjection,
  type AgentInfo,
  type AgentInit,
  type SessionEvent,
  type SessionState,
} from './model';

export const MAIN_AGENT_ID = 'main';

export type AgentCaps = Omit<CreateLoopOptions, 'input'>;

export interface Agent {
  readonly id: string;
  readonly reopened: boolean;
  readonly loop: Loop;
  readonly log: Log<LoopRecord>;
  readonly view: View<LoopRecordState>;
  readonly since: number;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type SessionSource = 'startup' | 'resume' | 'fork';

export interface LastTurn {
  readonly turnId: number;
  readonly outcome: TurnOutcome['type'];
}

export type SessionTurnOutcome = 'completed' | 'cancelled' | 'failed' | 'blocked';

export interface SessionStatus {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly source: SessionSource;
  readonly lastTurnReason?: SessionTurnOutcome;
}

export interface Session {
  readonly id: string;
  readonly source: SessionSource;
  readonly log: Log<SessionEvent>;
  readonly since: number;
  readonly roster: View<SessionState>;
  readonly blobs: BlobStore;
  readonly agents: ReadonlyMap<string, Agent>;
  open(agentId: string, caps: AgentCaps, init?: AgentInit): Promise<Agent>;
  fork(sourceId: string, agentId: string, caps: AgentCaps, init?: { readonly source?: string }): Promise<Agent>;
  undo(agentId: string, turns: number): Promise<void>;
  status(): SessionStatus;
  close(agentId?: string): Promise<void>;
}

export interface CreateSessionOptions {
  readonly id: string;
  readonly journal: Journal;
  readonly blobs: BlobStore;
  readonly source?: SessionSource;
  readonly lastTurn?: LastTurn;
  readonly onLastTurn?: (lastTurn: LastTurn | undefined) => void;
  readonly onClosed?: () => void;
}

export type SessionErrorReason =
  | 'invalid-agent'
  | 'agent-exists'
  | 'unknown-agent'
  | 'invalid-count'
  | 'insufficient'
  | 'busy';

export class SessionError extends Error {
  constructor(readonly reason: SessionErrorReason, message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

const agentIdPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function assertAgentId(agentId: string): void {
  if (!agentIdPattern.test(agentId)) throw new SessionError('invalid-agent', `invalid agent id '${agentId}'`);
}

function openAgent(
  id: string,
  log: Log<LoopRecord>,
  caps: AgentCaps,
  reopened: boolean,
  onError: (error: unknown) => void = console.error,
): Agent {
  const view = log.replica.view(loopProjection());
  const { messages, nextTurnId, unfinished, notify, profile } = view.getState();
  const loop = createLoop({ ...caps, input: { messages, nextTurnId, unfinished, inbox: { notify }, profile } });
  let batch: LoopRecord[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const flush = (): Promise<void> => {
    if (batch.length > 0) {
      const events = batch;
      batch = [];
      tail = log.commit({ events }).catch((error: unknown) => {
        onError(error);
        void loop.close();
      });
    }
    return tail.then(() => undefined);
  };
  const stop = loop.subscribe((event) => {
    const record = toLoopRecord(event);
    if (record === undefined) return;
    if (batch.length === 0) queueMicrotask(() => void flush());
    batch.push(record);
  });
  return {
    id,
    reopened,
    loop,
    log,
    view,
    since: log.version,
    flush,
    close: async () => {
      await loop.close();
      stop();
      await flush();
      view.dispose();
    },
  };
}

function lastTurnOf(state: LoopRecordState): LastTurn | undefined {
  const turn = state.turns.findLast((position) => position.outcome !== undefined);
  return turn?.outcome === undefined ? undefined : { turnId: turn.turnId, outcome: turn.outcome.type };
}

function sameTools(a: LoopProfile, b: LoopProfile): boolean {
  return JSON.stringify(a.tools ?? []) === JSON.stringify(b.tools ?? []);
}

function sameTurn(a: LastTurn | undefined, b: LastTurn | undefined): boolean {
  return a?.turnId === b?.turnId && a?.outcome === b?.outcome;
}

function reasonOf(outcome: LastTurn['outcome']): SessionTurnOutcome {
  if (outcome === 'done') return 'completed';
  if (outcome === 'aborted') return 'cancelled';
  return outcome;
}

export async function createSession(options: CreateSessionOptions): Promise<Session> {
  const writer = openWriter(options.journal);
  try {
    const log = await writer.open<SessionEvent>(SESSION_LOG);
    const roster = log.replica.view(sessionProjection());
    const source = options.source ?? 'startup';
    const agents = shallowReactive(new Map<string, Agent>());
    const opening = new Map<string, Promise<Agent>>();
    const released: Array<() => void> = [];
    let lastTurn = options.lastTurn;
    let closing: Promise<void> | undefined;

    const isKnown = (agentId: string): boolean =>
      opening.has(agentId) || roster.getState().agents[agentId] !== undefined;

    const register = (agentId: string, info: AgentInfo): Promise<number> =>
      log.commit({ events: [{ type: 'agent.registered', agentId, ...info }] });

    const settleLastTurn = (next: LastTurn | undefined): void => {
      if (sameTurn(lastTurn, next)) return;
      lastTurn = next;
      options.onLastTurn?.(next);
    };

    const attach = (agentId: string, agentLog: Log<LoopRecord>, caps: AgentCaps, reopened: boolean): Agent => {
      const agent = openAgent(agentId, agentLog, caps, reopened);
      agents.set(agentId, agent);
      if (agentId === MAIN_AGENT_ID) {
        settleLastTurn(lastTurnOf(agent.view.getState()));
        released.push(agent.view.subscribe((state) => settleLastTurn(lastTurnOf(state))));
      }
      return agent;
    };

    const claim = (agentId: string, start: () => Promise<Agent>): Promise<Agent> => {
      const pending = start();
      opening.set(agentId, pending);
      const settle = (): void => {
        if (opening.get(agentId) === pending) opening.delete(agentId);
      };
      pending.then(settle, settle);
      return pending;
    };

    const open: Session['open'] = async (agentId, caps, init = {}) => {
      assertAgentId(agentId);
      const live = agents.get(agentId) ?? opening.get(agentId);
      if (live !== undefined) return live;
      return claim(agentId, async () => {
        const reopened = roster.getState().agents[agentId] !== undefined;
        if (!reopened) await register(agentId, init);
        return attach(agentId, await writer.open<LoopRecord>(`${AGENT_LOG_PREFIX}${agentId}`), caps, reopened);
      });
    };

    const fork: Session['fork'] = async (sourceId, agentId, caps, init = {}) => {
      assertAgentId(agentId);
      if (isKnown(agentId)) throw new SessionError('agent-exists', `agent '${agentId}' already exists`);
      if (!isKnown(sourceId)) throw new SessionError('unknown-agent', `unknown agent '${sourceId}'`);
      return claim(agentId, async () => {
        const live = agents.get(sourceId);
        await live?.flush();
        const sourceLog = live?.log ?? (await writer.open<LoopRecord>(`${AGENT_LOG_PREFIX}${sourceId}`));
        const target = await writer.open<LoopRecord>(`${AGENT_LOG_PREFIX}${agentId}`);
        if (target.version !== 0) throw new SessionError('agent-exists', `agent '${agentId}' already exists`);
        const events = sourceLog.replica.entries().map((entry) => entry.event);
        if (events.length > 0) await target.commit({ events });
        await register(agentId, { source: init.source, forkedFrom: { agentId: sourceId, version: sourceLog.version } });
        return attach(agentId, target, caps, false);
      });
    };

    const undo: Session['undo'] = async (agentId, turns) => {
      if (!Number.isSafeInteger(turns) || turns <= 0) {
        throw new SessionError('invalid-count', `invalid undo count: ${turns}`);
      }
      const agent = agents.get(agentId);
      if (agent === undefined) throw new SessionError('unknown-agent', `agent '${agentId}' is not open`);
      if (agent.loop.state.status !== 'idle') throw new SessionError('busy', `agent '${agentId}' is not idle`);
      await agent.flush();
      const cut = agent.view.getState().turns.at(-turns);
      if (cut === undefined) {
        throw new SessionError('insufficient', `cannot undo ${turns} turn(s): not enough turns`);
      }
      await agent.log.commit({ rewind: cut.start });
      const profile = agent.view.getState().profile;
      if (profile.systemPrompt !== agent.loop.state.profile.systemPrompt) {
        agent.loop.setSystemPrompt(profile.systemPrompt);
      }
      if (!sameTools(profile, agent.loop.state.profile)) {
        agent.loop.setTools([...(profile.tools ?? [])]);
      }
      const ack = agent.loop.setContext([...agent.view.getState().messages], 'undo');
      if (ack?.type !== 'context.settled') throw new SessionError('busy', `agent '${agentId}' is running`);
      await agent.flush();
    };

    const closeAgent = async (agentId: string): Promise<void> => {
      const agent = agents.get(agentId);
      if (agent === undefined) return;
      agents.delete(agentId);
      await agent.close();
    };

    const status: Session['status'] = () => {
      let busy = false;
      let mainTurnActive = false;
      for (const agent of agents.values()) {
        const state = agent.loop.state;
        const active = state.status === 'running';
        if (active || state.tools.some((tool) => tool.detached)) busy = true;
        if (agent.id === MAIN_AGENT_ID) mainTurnActive = active;
      }
      return {
        busy,
        mainTurnActive,
        source,
        ...(lastTurn === undefined ? {} : { lastTurnReason: reasonOf(lastTurn.outcome) }),
      };
    };

    const close: Session['close'] = (agentId) => {
      if (agentId !== undefined) return closeAgent(agentId);
      closing ??= (async () => {
        await Promise.allSettled(opening.values());
        for (const release of released.splice(0)) release();
        await Promise.allSettled([...agents.keys()].map(closeAgent));
        roster.dispose();
        await writer.close();
        options.onClosed?.();
      })();
      return closing;
    };

    for (const name of await writer.names(AGENT_LOG_PREFIX)) {
      const agentId = name.slice(AGENT_LOG_PREFIX.length);
      if (agentIdPattern.test(agentId) && !isKnown(agentId)) await register(agentId, {});
    }

    return {
      id: options.id,
      source,
      log,
      since: log.version,
      roster,
      blobs: options.blobs,
      agents,
      open,
      fork,
      undo,
      status,
      close,
    };
  } catch (error) {
    await writer.close();
    throw error;
  }
}
