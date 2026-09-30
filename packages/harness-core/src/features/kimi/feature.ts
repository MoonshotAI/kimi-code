import {
  createFeature,
  useProvider,
  useProviderProtocol,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import type { UnitSetup } from '@moonshot-ai/agent-core/kernel/index';

import { createFetchSlots, type CreateFetchProps } from './fetch/feature';
import { createOauthSlots, type CreateOauthProps } from './oauth/feature';
import { kimiProtocolBindings, kimiProvider } from './provider';
import { sessionTitleSlots } from './sessionTitle/feature';
import { traceSlots } from './trace/feature';
import { createWebSlots, type CreateWebProps } from './web/feature';

export interface CreateKimiProps {
  readonly oauth?: CreateOauthProps;
  readonly web?: CreateWebProps;
  readonly fetch?: CreateFetchProps;
}

export function createKimi(props: CreateKimiProps = {}): FeatureSpec {
  const oauth = createOauthSlots(props.oauth);
  const web = createWebSlots(props.web);
  const fetch = createFetchSlots(props.fetch);
  return createFeature('kimi', {
    app: composeSlots(kimiAppSlot, oauth.app, web.app, fetch.app),
    session: sessionTitleSlots.session,
    agent: composeSlots(web.agent, fetch.agent, sessionTitleSlots.agent, traceSlots.agent),
  });
}

function kimiAppSlot(): void {
  useProvider({ handle: kimiProvider });
  useProviderProtocol({ type: 'kimi', protocols: () => kimiProtocolBindings() });
}

function composeSlots(...setups: ReadonlyArray<UnitSetup<void> | undefined>): UnitSetup<void> {
  return (props, ctx) => {
    const cleanups: Array<() => void | Promise<void>> = [];
    for (const setup of setups) {
      const result = setup?.(props, ctx);
      if (typeof result === 'function') {
        cleanups.push(result as () => void | Promise<void>);
      }
    }
    if (cleanups.length === 0) {
      return undefined;
    }
    return async () => {
      for (const cleanup of [...cleanups].reverse()) {
        await cleanup();
      }
    };
  };
}
