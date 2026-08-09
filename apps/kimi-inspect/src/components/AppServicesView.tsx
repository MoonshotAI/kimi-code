/**
 * App Services view — the app-scope (server-level) Service reflection as a
 * standalone rail view. Postman-style three-pane layout
 * (`ScopePanelsScrollspy`): the Service list on the left, every Service's
 * methods expanded in one continuously scrolling column in the middle
 * (scroll position and left-side highlight kept in sync), and a
 * request/response call history on the right. The proxies resolve on the
 * `core` route, so this view works before any session is selected.
 */

import { useCallback } from 'react';

import { serviceByName } from '../channel';
import { useConnection } from '../connection';
import type { AnyService } from '../panels';
import { ScopePanelsScrollspy } from './ServicePanels';

export function AppServicesView() {
  const { klient } = useConnection();
  const proxyFor = useCallback(
    (name: string): AnyService | null =>
      serviceByName<AnyService>(klient, name, { scope: 'app' }) ?? null,
    [klient],
  );

  return <ScopePanelsScrollspy scope="app" title="App Services" proxyFor={proxyFor} />;
}
