import type { ActorRefFrom } from 'xstate';

import type { HistoryMessage } from '#/agent/turn';
import type { TurnEntryData, TurnOutcome } from '#/agent/replay';
import type { Branch } from '#/store/branch';
import type { AppendInput } from '#/store/types';

import type { createAgentMachine } from '#/agent/machine';

type AgentActor = ActorRefFrom<ReturnType<typeof createAgentMachine>>;
type AgentSnapshot = ReturnType<AgentActor['getSnapshot']>;

export interface PersistAgentOptions {
  states?: Record<string, () => unknown>;
  persistedMessages?: number;
  onError?: (error: unknown) => void;
}

export interface AgentPersistence {
  readonly persistedMessages: number;
  flush(): Promise<void>;
  dispose(): void;
}

interface BufferedTurnEvent {
  kind: 'start' | 'end';
  turnId?: number;
  outcome?: TurnOutcome;
  messageCount?: number;
}

function countPersistedMessages(branch: Branch): number {
  let count = 0;
  for (const entry of branch.walk()) {
    if (entry.type === 'message') count += 1;
  }
  return count;
}

export function persistAgent(actor: AgentActor, branch: Branch, opts?: PersistAgentOptions): AgentPersistence {
  const report = opts?.onError ?? ((error: unknown) => console.error(error));
  const write = (input: AppendInput): void => {
    void branch.append(input).catch(report);
  };
  const writeMessage = (message: HistoryMessage): void => {
    void branch.append({ type: 'message', kind: 'agent', data: message }).then(
      () => {
        completed += 1;
      },
      report,
    );
  };

  let queued = opts?.persistedMessages ?? countPersistedMessages(branch);
  let completed = queued;
  let currentTurnId: number | undefined;
  const buffered: BufferedTurnEvent[] = [];
  const stateValues = new Map<string, string>();
  for (const [name, get] of Object.entries(opts?.states ?? {})) {
    stateValues.set(name, JSON.stringify(get()));
  }

  const subscriptions = [
    actor.on('turn.start', (event) => {
      if (event.type !== 'turn.start') return;
      currentTurnId = event.turnId;
      buffered.push({ kind: 'start', turnId: event.turnId });
    }),
    actor.on('turn.done', (event) => {
      if (event.type !== 'turn.done') return;
      buffered.push({ kind: 'end', outcome: 'done', messageCount: event.messages.length });
    }),
    actor.on('turn.failed', (event) => {
      if (event.type !== 'turn.failed') return;
      buffered.push({ kind: 'end', outcome: 'failed', messageCount: event.messages.length });
    }),
    actor.on('turn.aborted', (event) => {
      if (event.type !== 'turn.aborted') return;
      buffered.push({ kind: 'end', outcome: 'aborted', messageCount: event.messages.length });
    }),
  ];

  const flushSnapshot = (snapshot: AgentSnapshot): void => {
    const context = snapshot.context;
    const writeUpTo = (count: number): void => {
      while (queued < count) {
        writeMessage(context.messages[queued] as HistoryMessage);
        queued += 1;
      }
    };
    for (const event of buffered) {
      if (event.kind === 'end') {
        writeUpTo(event.messageCount ?? queued);
        const data: TurnEntryData = {
          phase: 'end',
          turnId: currentTurnId,
          outcome: event.outcome as TurnOutcome,
        };
        write({ type: 'turn', kind: 'agent', data });
      } else {
        writeUpTo(context.messages.length);
        const data: TurnEntryData = { phase: 'start', turnId: event.turnId as number };
        write({ type: 'turn', kind: 'agent', data });
      }
    }
    buffered.length = 0;
    writeUpTo(context.messages.length);
    for (const [name, get] of Object.entries(opts?.states ?? {})) {
      const value = get();
      const json = JSON.stringify(value);
      if (json !== stateValues.get(name)) {
        stateValues.set(name, json);
        write({ type: 'state', kind: 'agent', data: { name, value } });
      }
    }
  };

  const subscription = actor.subscribe((snapshot) => {
    flushSnapshot(snapshot);
  });

  return {
    get persistedMessages() {
      return completed;
    },
    flush: () => branch.settled(),
    dispose: () => {
      subscription.unsubscribe();
      for (const sub of subscriptions) {
        sub.unsubscribe();
      }
    },
  };
}
