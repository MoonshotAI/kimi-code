/**
 * The transport-agnostic klient factory. Every transport entry point
 * (`@moonshot-ai/klient/http|ipc|memory`) builds a `KlientChannel` and hands
 * it here; the returned `Klient` is identical in shape and behavior no matter
 * which transport carried the bytes.
 */

import type { KlientChannel, ScopeRef } from './channel.js';
import { globalContract } from '#/contract/index';
import { globalEvents, type KlientEventPayloads } from '#/contract/global/events';
import { sessionEvents, type SessionEventPayloads } from '#/contract/session/events';
import { agentEvents, type AgentEventPayloads } from '#/contract/agent/events';
import type { EventRegistration } from '#/contract/types';
import { EventHub, type KlientEvents } from './events/hub.js';
import { createGlobalFacade, type GlobalFacade, type ScopedCaller } from './facade/global.js';
import { createSessionFacade, type SessionFacade } from './facade/session.js';
import { createAgentFacade, type AgentFacade } from './facade/agent.js';
import { parseInput, parseOutput } from './validation.js';

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
    const name = `${service}.${method}`;
    const wireArgs = validate ? parseInput(name, procedure, args) : args;
    const data = await channel.call(scope, service, method, wireArgs);
    return validate ? parseOutput(name, procedure, data) : data;
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
    global: createGlobalFacade(call),
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
