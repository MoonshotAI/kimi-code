import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import type { UnitSetup } from '@moonshot-ai/agent-core/kernel/index';

import { useProvider, useProviderProtocol } from '#/features/provider-catalog/index';

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

export function createKimi(props: CreateKimiProps = {}): Feature<void> {
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
    for (const setup of setups) setup?.(props, ctx);
  };
}
