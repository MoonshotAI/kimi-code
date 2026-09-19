import { toValue, type MaybeRefOrGetter } from '@vue/reactivity';

import {
  createUnit,
  EventContext,
  mountRoot,
  provide,
  useChildren,
  type EffectScope,
  type NodeRef,
} from '#/kernel/index';

import { mountAgentFeatures, type AgentFeatureHost, type AgentFeatureUnitProps } from './agentFeatureUnit';
import type { FeatureSpec } from './feature';
import { featureHost, type FeatureHost } from './host';
import { slotEntries } from './slots';
import { SessionFeatureReady } from './runtime';

export interface SessionFeatureUnitProps {
  readonly sessionId: string;
  readonly features: MaybeRefOrGetter<readonly FeatureSpec<any>[]>;
  readonly provide?: (node: NodeRef) => void;
  readonly scope?: EffectScope;
}

export interface SessionFeatureHost extends FeatureHost {
  mountAgent(props: Omit<AgentFeatureUnitProps, 'sessionId' | 'features'> & {
    readonly features?: AgentFeatureUnitProps['features'];
  }): AgentFeatureHost;
}

export const SessionFeatureUnit = createUnit<SessionFeatureUnitProps>('session-features', (props, ctx) => {
  provide(EventContext, { sessionId: props.sessionId });
  props.provide?.(ctx.node);
  const children = useChildren(() => toValue(props.features).flatMap((feature) => slotEntries(feature, 'session')));
  provide(SessionFeatureReady, () => children.ready());
});

export function mountSessionFeatures(props: SessionFeatureUnitProps): SessionFeatureHost {
  const host = featureHost(mountRoot(SessionFeatureUnit, props, { scope: props.scope }).handle);
  const parentReady = host.node.resolve(SessionFeatureReady);
  return Object.assign(host, {
    mountAgent: (agent: Parameters<SessionFeatureHost['mountAgent']>[0]) => mountAgentFeatures({
      ...agent,
      sessionId: props.sessionId,
      features: agent.features ?? props.features,
      parentReady,
    }, host.node),
  });
}
