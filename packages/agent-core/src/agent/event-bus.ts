import type { AgentEvent } from '#/rpc';
import { createDecorator } from '../di';
import type { IDisposable } from '../di';

export interface IAgentEventBus {
  readonly _serviceBrand: undefined;

  publish(event: AgentEvent): void;

  subscribe<T extends AgentEvent['type']>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void,
  ): IDisposable;

  subscribeAll(handler: (event: AgentEvent) => void): IDisposable;
}

export const IAgentEventBus = createDecorator<IAgentEventBus>('agentEventBus');

type AnyHandler = (event: AgentEvent) => void;

export class AgentEventBus implements IAgentEventBus {
  readonly _serviceBrand: undefined;

  private readonly typed = new Map<AgentEvent['type'], Set<AnyHandler>>();
  private readonly all = new Set<AnyHandler>();

  constructor(private readonly forward: (event: AgentEvent) => void) {}

  publish(event: AgentEvent): void {
    const typed = this.typed.get(event.type);
    if (typed !== undefined) {
      for (const handler of typed) handler(event);
    }
    for (const handler of this.all) handler(event);
    this.forward(event);
  }

  subscribe<T extends AgentEvent['type']>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void,
  ): IDisposable {
    let set = this.typed.get(type);
    if (set === undefined) {
      set = new Set();
      this.typed.set(type, set);
    }
    const h = handler as AnyHandler;
    set.add(h);
    return { dispose: () => set.delete(h) };
  }

  subscribeAll(handler: (event: AgentEvent) => void): IDisposable {
    this.all.add(handler);
    return { dispose: () => this.all.delete(handler) };
  }
}
