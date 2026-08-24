import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import type { AgentDomainTrait, Event2, Event2Class } from './event2';

export interface IEventBus {
  readonly _serviceBrand: undefined;

  publish(event: Event2<any>, agent?: AgentContext): void;
  subscribe(handler: (event: Event2<any>) => void): IDisposable;
  subscribe<P, E extends Event2<P>>(cls: Event2Class<P, E>, handler: (event: E) => void): IDisposable;
  subscribe(type: string, handler: (event: Event2<any>) => void): IDisposable;
}

export const IEventBus: ServiceIdentifier<IEventBus> = createDecorator<IEventBus>('eventBus');

export interface ISessionEventBus extends IEventBus {
  activateAgent(agent: AgentContext): void;
  deactivateAgent(agent: AgentContext): void;
  sourceOf(event: Event2<any>): AgentContext | undefined;
  onAgent<P extends AgentDomainTrait, E extends Event2<P>>(
    agent: AgentContext,
    cls: Event2Class<P, E>,
    handler: (event: E) => void,
  ): IDisposable;
  onAgent(
    agent: AgentContext,
    type: string,
    handler: (event: Event2<any> & AgentDomainTrait) => void,
  ): IDisposable;
}

export const ISessionEventBus: ServiceIdentifier<ISessionEventBus> =
  createDecorator<ISessionEventBus>('sessionEventBus');
