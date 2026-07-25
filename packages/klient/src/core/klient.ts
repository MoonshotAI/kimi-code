/**
 * The transport-agnostic klient factory. Every transport entry point
 * (`@moonshot-ai/klient/ipc|memory`) builds a `KlientChannel` and hands
 * it here; the returned `Klient` is identical in shape and behavior no matter
 * which transport carried the bytes.
 */

import type { KlientChannel, ScopeRef } from './channel.js';
import { globalContract, isStreamingContract } from '#/contract/index';
import { globalEvents, type KlientEventPayloads } from '#/contract/global/events';
import { sessionEvents, type SessionEventPayloads } from '#/contract/session/events';
import { agentEvents, type AgentEventPayloads } from '#/contract/agent/events';
import type { EventRegistration, StreamingProcedureContract } from '#/contract/types';
import { EventHub, type KlientEvents } from './events/hub.js';
import { createGlobalFacade, type GlobalFacade, type ScopedCaller, type ScopedStreamCaller } from './facade/global.js';
import { createSessionFacade, type SessionFacade } from './facade/session.js';
import { createAgentFacade, type AgentFacade } from './facade/agent.js';
import { parseChunk, parseInput, parseOutput } from './validation.js';

export interface KlientOptions {
  /**
   * Validate wire inputs/outputs and event payloads against the contract.
   * Default `true`. Disable only on measured hot paths — validation is cheap
   * (sub-µs for typical payloads) and is the drift tripwire.
   */
  readonly validate?: boolean;
}

export interface SessionHandle extends SessionFacade {
  readonly events: KlientEvents<SessionEventPayloads>;
  agent(agentId: string): AgentHandle;
}

export interface AgentHandle extends AgentFacade {
  readonly events: KlientEvents<AgentEventPayloads>;
}

export interface Klient {
  readonly global: GlobalFacade;
  readonly events: KlientEvents;
  session(sessionId: string): SessionHandle;
  close(): Promise<void>;
}

export function createKlientFromChannel(
  channel: KlientChannel,
  options: KlientOptions = {},
): Klient {
  const validate = options.validate ?? true;

  const call: ScopedCaller = async (scope, service, method, args) => {
    const procedure = globalContract[service]?.[method];
    if (procedure === undefined) {
      // A facade method without a contract entry is a klient bug, not a wire error.
      throw new Error(`no contract registered for ${service}.${method}`);
    }
    if (isStreamingContract(procedure)) {
      throw new Error(`${service}.${method} is a streaming procedure — use callStream instead`);
    }
    const name = `${service}.${method}`;
    const wireArgs = validate ? parseInput(name, procedure, args) : args;
    const data = await channel.call(scope, service, method, wireArgs);
    return validate ? parseOutput(name, procedure, data) : data;
  };

  const callStream: ScopedStreamCaller = (scope, service, method, args) => {
    const procedure = globalContract[service]?.[method];
    if (procedure === undefined) {
      throw new Error(`no contract registered for ${service}.${method}`);
    }
    if (!isStreamingContract(procedure)) {
      throw new Error(`${service}.${method} is not a streaming procedure — use call instead`);
    }
    const name = `${service}.${method}`;
    const wireArgs = validate ? parseInput(name, procedure, args) : args;
    const source = channel.stream(scope, service, method, wireArgs);
    if (!validate) return source;

    // Wrap the iterable to validate each chunk.
    const contract = procedure as StreamingProcedureContract;
    return {
      [Symbol.asyncIterator]() {
        const iter = source[Symbol.asyncIterator]();
        return {
          async next() {
            const result = await iter.next();
            if (result.done) return { done: true as const, value: undefined };
            return { done: false, value: parseChunk(name, contract, result.value) };
          },
          async return(value?: unknown) {
            await iter.return?.(value);
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  };

  const hubs = new Set<{ close(): void }>();
  const makeHub = <TPayloadMap extends object>(
    scope: ScopeRef,
    registrations: Record<string, EventRegistration>,
  ): KlientEvents<TPayloadMap> => {
    const hub = new EventHub<TPayloadMap>(channel, validate, scope, registrations);
    hubs.add(hub);
    return hub;
  };

  return {
    global: createGlobalFacade(call, callStream),
    events: makeHub<KlientEventPayloads>({}, globalEvents),
    session(sessionId: string): SessionHandle {
      const scope: ScopeRef = { sessionId };
      return {
        ...createSessionFacade(call, sessionId),
        events: makeHub<SessionEventPayloads>(scope, sessionEvents),
        agent(agentId: string): AgentHandle {
          const agentScope: ScopeRef = { sessionId, agentId };
          return {
            ...createAgentFacade(call, agentScope),
            events: makeHub<AgentEventPayloads>(agentScope, agentEvents),
          };
        },
      };
    },
    close: () => {
      for (const hub of hubs) {
        hub.close();
      }
      hubs.clear();
      return channel.close();
    },
  };
}
