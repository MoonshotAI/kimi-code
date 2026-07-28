// apps/web src/api/bootstrap.ts — composes the DaemonKimiWebApi (web-core) with
// the apps/web tracer, credential store, and agent projector, and exposes the
// shared singleton.
//
// This is the only module that knows both sides: web-core's api client and
// apps/web's debug/trace + serverAuth + projector. Everything else consumes the
// composed `api` (or the back-compat `getKimiWebApi()` accessor).

import { DaemonKimiWebApi } from '@moonshot-ai/web-core/api';
import type { CredentialStore, Tracer } from '@moonshot-ai/web-core/contracts';
import {
  traceRestFailure,
  traceRestRequest,
  traceRestResponse,
  traceWsIn,
  traceWsLifecycle,
  traceWsOut,
  traceKeyEvent as recordKeyEvent,
} from '../debug/trace';
import { getCredential, markAuthRequired } from '../lib/serverAuth';
import { readKimiApiConfig } from './config';
import { createAgentProjector } from './daemon/agentEventProjector';
import type { KimiWebApi } from './types';

const webTracer: Tracer = {
  restRequest: (info) => traceRestRequest(info),
  restResponse: (info) => traceRestResponse(info),
  restFailure: (info) => traceRestFailure(info),
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

const webCredentialStore: CredentialStore = {
  getToken: getCredential,
  markAuthRequired,
};

function createApi(): KimiWebApi {
  const config = readKimiApiConfig();
  return new DaemonKimiWebApi({
    origin: config.serverHttpUrl,
    identity: {
      clientId: config.clientId,
      clientName: config.clientName,
      clientVersion: config.clientVersion,
      clientUiMode: config.clientUiMode,
    },
    tracer: webTracer,
    credentialStore: webCredentialStore,
    projectorFactory: createAgentProjector,
    mainAgentOnly: true,
  });
}

/** The shared DaemonKimiWebApi instance (composed with apps/web's bridges). */
export const api: KimiWebApi = createApi();

/**
 * Back-compat accessor kept so the existing `getKimiWebApi()` call sites need no
 * changes; returns the same singleton as `api`.
 */
export function getKimiWebApi(): KimiWebApi {
  return api;
}
