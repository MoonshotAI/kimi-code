import { createFeature, type Feature, type FeatureLevelSetup } from '#/app/index';

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

function composeSlots(
  ...setups: ReadonlyArray<FeatureLevelSetup<void, any, any> | undefined>
): FeatureLevelSetup<void, any, any> {
  return (props, ctx) => {
    for (const setup of setups) setup?.(props, ctx);
  };
}
