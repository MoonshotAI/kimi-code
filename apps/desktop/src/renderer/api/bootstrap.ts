
import { createKimiWebApi } from '@moonshot-ai/app-core/api';
import type { CredentialStore, Tracer } from '@moonshot-ai/app-core/contracts';
import {
  traceRestAbort,
  traceRestFailure,
  traceRestRequest,
  traceRestResponse,
  traceWsIn,
  traceWsLifecycle,
  traceWsOut,
  traceKeyEvent as recordKeyEvent,
} from '@moonshot-ai/app-client/trace';
import { getCredential, markAuthRequired } from '@moonshot-ai/app-core/lib';
import { readKimiApiConfig } from './config';
import type { KimiWebApi } from './types';

const appTracer: Tracer = {
  restRequest: (info) => traceRestRequest(info),
  restResponse: (info) => traceRestResponse(info),
  restFailure: (info) => traceRestFailure(info),
  restAbort: (info) => traceRestAbort(info),
  wsEvent: (event) => {
    switch (event.kind) {
      case 'lifecycle':
        traceWsLifecycle(event.event, event.detail);
        break;
      case 'in':
        traceWsIn(event.frame);
        break;
      case 'out':
        traceWsOut(event.frame);
        break;
    }
  },
  traceKeyEvent: (event, info) => recordKeyEvent(event as never, info),
};

const appCredentialStore: CredentialStore = {
  getToken: getCredential,
  markAuthRequired,
};

function createApi(): KimiWebApi {
  const config = readKimiApiConfig();
  return createKimiWebApi({
    origin: config.serverHttpUrl,
    identity: {
      clientId: config.clientId,
      clientName: config.clientName,
      clientVersion: config.clientVersion,
      clientUiMode: config.clientUiMode,
    },
    tracer: appTracer,
    credentialStore: appCredentialStore,
  });
}

export const api: KimiWebApi = createApi();

if (import.meta.hot) {
  import.meta.hot.dispose(() => api.dispose());
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __kimiApi: unknown }).__kimiApi = api;
}

export function getKimiWebApi(): KimiWebApi {
  return api;
}
