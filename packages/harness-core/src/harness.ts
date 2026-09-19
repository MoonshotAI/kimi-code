import { mountApp, type AppHandle, type AppUnitProps, type LlmRequester } from '@moonshot-ai/agent-core';

import {
  bindOpenSession,
  HarnessSessionBindRef,
  OpenSessionRef,
  SessionSpaceRef,
  type HarnessSessionBind,
  type SessionSpace,
} from '#/host/session';

export interface HarnessProps extends AppUnitProps {
  readonly space: SessionSpace;
  readonly requester: LlmRequester;
  readonly agent?: HarnessSessionBind['agent'];
}

export function mountHarness(props: HarnessProps): AppHandle {
  const { space, requester, agent, provide, ...rest } = props;
  const bind: HarnessSessionBind = { requester, agent };
  return mountApp({
    ...rest,
    provide(node) {
      node.provide(SessionSpaceRef, space);
      node.provide(HarnessSessionBindRef, bind);
      node.provide(OpenSessionRef, bindOpenSession(space, bind));
      provide?.(node);
    },
  });
}
