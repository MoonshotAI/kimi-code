import { toValue, type MaybeRefOrGetter } from '@vue/reactivity';

import type { AgentMachineSelf } from '#/agent/machine';
import type { AgentEventStore } from '#/agent/slices';
import {
  AgentScope,
  createUnit,
  EventStoreService,
  mountRoot,
  NodeEnrichment,
  provide,
  useChildren,
  watchEffect,
  type EffectScope,
  type NodeRef,
  type Unsubscribe,
  type UnitHandle,
} from '#/kernel/index';
import { createAgentPluginTarget, type AgentPluginSource } from '#/plugin';
import type { ToolDefinition } from '#/tool/tool';

import { createDurableBackend } from './durable';
import type { FeatureSpec } from './feature';
import { AgentContext, AgentRuntime } from './runtime';
import { slotEntries } from './slots';
import { ToolDefinitions } from './tool';

export interface FeatureToolSink {
  register(definition: ToolDefinition): Unsubscribe;
}

export interface AgentFeatureUnitProps {
  readonly self: AgentMachineSelf;
  readonly store: AgentEventStore;
  readonly sessionId: string;
  readonly agentId: string;
  readonly features: MaybeRefOrGetter<readonly FeatureSpec<any>[]>;
  readonly toolSink?: FeatureToolSink;
  readonly provide?: (node: NodeRef) => void;
  readonly scope?: EffectScope;
}

export const AgentFeatureUnit = createUnit<AgentFeatureUnitProps>('agent-features', (props, ctx) => {
  provide(AgentContext, { sessionId: props.sessionId, agentId: props.agentId });
  provide(NodeEnrichment, { sessionId: props.sessionId, agentId: props.agentId });
  provide(EventStoreService, createDurableBackend(props.store));
  provide(AgentRuntime, createAgentPluginTarget(props.self as unknown as AgentPluginSource));
  if (props.scope !== undefined) {
    provide(AgentScope, props.scope);
  }
  props.provide?.(ctx.node);
  const unregisters = new Map<ToolDefinition, Unsubscribe>();
  if (props.toolSink !== undefined) {
    const sink = props.toolSink;
    watchEffect(() => {
      const definitions = ctx.node.fold(ToolDefinitions);
      const seen = new Set<ToolDefinition>();
      for (const definition of definitions) {
        seen.add(definition);
        if (!unregisters.has(definition)) {
          unregisters.set(definition, sink.register(definition));
        }
      }
      for (const [definition, unregister] of Array.from(unregisters)) {
        if (!seen.has(definition)) {
          unregisters.delete(definition);
          unregister();
        }
      }
    });
  }
  useChildren(() => toValue(props.features).flatMap((feature) => slotEntries(feature, 'agent')));
  return () => {
    for (const unregister of unregisters.values()) {
      unregister();
    }
    unregisters.clear();
  };
});

export function mountAgentFeatures(props: AgentFeatureUnitProps): UnitHandle {
  return mountRoot(AgentFeatureUnit, props, { scope: props.scope }).handle;
}
