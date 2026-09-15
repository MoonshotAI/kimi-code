import { toValue, type MaybeRefOrGetter } from '@vue/reactivity';

import type { AgentMachineSelf } from '#/agent/machine';
import type { AgentEventStore } from '#/agent/slices';
import {
  AgentScope,
  createUnit,
  EventContext,
  EventStoreService,
  mountRoot,
  provide,
  useChildren,
  type EffectScope,
  type NodeRef,
  type UnitHandle,
} from '#/kernel/index';
import { createAgentPluginTarget, type AgentPluginSource } from '#/plugin';

import { createDurableBackend } from './durable';
import type { FeatureSpec } from './feature';
import { AgentContext, AgentRuntime } from './runtime';
import { slotEntries } from './slots';

export interface AgentFeatureUnitProps {
  readonly self: AgentMachineSelf;
  readonly store: AgentEventStore;
  readonly sessionId: string;
  readonly agentId: string;
  readonly features: MaybeRefOrGetter<readonly FeatureSpec<any>[]>;
  readonly provide?: (node: NodeRef) => void;
  readonly scope?: EffectScope;
}

export const AgentFeatureUnit = createUnit<AgentFeatureUnitProps>('agent-features', (props, ctx) => {
  provide(AgentContext, { sessionId: props.sessionId, agentId: props.agentId });
  provide(EventContext, { sessionId: props.sessionId, agentId: props.agentId });
  provide(EventStoreService, createDurableBackend(props.store));
  provide(AgentRuntime, createAgentPluginTarget(props.self as unknown as AgentPluginSource));
  if (props.scope !== undefined) {
    provide(AgentScope, props.scope);
  }
  props.provide?.(ctx.node);
  useChildren(() => toValue(props.features).flatMap((feature) => slotEntries(feature, 'agent')));
});

export function mountAgentFeatures(props: AgentFeatureUnitProps): UnitHandle {
  return mountRoot(AgentFeatureUnit, props, { scope: props.scope }).handle;
}
