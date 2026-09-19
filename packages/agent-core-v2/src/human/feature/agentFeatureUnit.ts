import { toValue, type MaybeRefOrGetter } from '@vue/reactivity';

import type { AgentMachineSelf } from '#/agent/machine';
import type { AgentEventStore } from '#/agent/slices';
import {
  createUnit,
  EventContext,
  mountRoot,
  provide,
  useChildren,
  useReady,
  ref,
  type EffectScope,
  type NodeRef,
} from '#/kernel/index';
import { EventStoreService } from '#/store/index';

import { AgentExtensions, createAgentExtensions, type AgentExtensionRegistry } from './extensions';
import type { FeatureSpec } from './feature';
import { featureHost, type FeatureHost } from './host';
import { AgentContext, AgentRuntime, AgentScope, createAgentRuntime } from './runtime';
import { slotEntries } from './slots';

export interface AgentFeatureUnitProps {
  readonly self: AgentMachineSelf;
  readonly store: AgentEventStore;
  readonly sessionId: string;
  readonly agentId: string;
  readonly features: MaybeRefOrGetter<readonly FeatureSpec<any>[]>;
  readonly provide?: (node: NodeRef) => void;
  readonly scope?: EffectScope;
  readonly parentReady?: () => Promise<void>;
}

export interface AgentFeatureHost extends FeatureHost {
  readonly extensions: AgentExtensionRegistry;
}

export const AgentFeatureUnit = createUnit<AgentFeatureUnitProps>('agent-features', (props, ctx) => {
  provide(AgentContext, { sessionId: props.sessionId, agentId: props.agentId });
  provide(EventContext, { sessionId: props.sessionId, agentId: props.agentId });
  provide(EventStoreService, props.store);
  provide(AgentRuntime, createAgentRuntime(props.self));
  provide(AgentExtensions, createAgentExtensions());
  if (props.scope !== undefined) {
    provide(AgentScope, props.scope);
  }
  props.provide?.(ctx.node);
  const initialized = ref(props.parentReady === undefined);
  if (props.parentReady !== undefined) {
    useReady(props.parentReady().then(() => {
      if (!ctx.node.signal.aborted) initialized.value = true;
    }));
  }
  useChildren(() => initialized.value ? toValue(props.features).flatMap((feature) => slotEntries(feature, 'agent')) : []);
});

export function mountAgentFeatures(props: AgentFeatureUnitProps, parent?: NodeRef): AgentFeatureHost {
  const handle = parent === undefined
    ? mountRoot(AgentFeatureUnit, props, { scope: props.scope }).handle
    : parent.mount(AgentFeatureUnit, props);
  return Object.assign(featureHost(handle), {
    extensions: handle.node.resolve(AgentExtensions),
    ready: async () => {
      const { signal } = handle.node;
      let cancel = (): void => {};
      const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        await Promise.race([props.parentReady?.(), cancelled]);
        await handle.ready();
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
  });
}
