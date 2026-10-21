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
