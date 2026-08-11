// app-core api/createKimiWebApi — the composition root both app shells
// (desktop renderer / web) use: DaemonKimiWebApi wired with the in-package
// agent event projector. The shells inject their tracer, credential store,
// identity, and translator; each keeps only a thin bootstrap of its own
// (runtime config, bridge objects, the singleton accessor).

import type { ClientIdentity, CredentialStore, Tracer, Translator } from '../contracts';
import { DaemonKimiWebApi } from './daemon/client';
import { createAgentProjector } from './daemon/agentEventProjector';
import type { KimiWebApi } from './types';

export interface CreateKimiWebApiDeps {
  origin: string;
  identity: ClientIdentity;
  tracer: Tracer;
  credentialStore: CredentialStore;
  /** Translator for projector-emitted text (the shell's vue-i18n global `t`). */
  t: Translator;
  /** Desktop keeps legacy raw events main-only while auxiliary views use
   *  Transcript; web omits this. Each shell chooses — see the ownership matrix. */
  mainAgentOnly?: boolean;
}

export function createKimiWebApi(deps: CreateKimiWebApiDeps): KimiWebApi {
  return new DaemonKimiWebApi({
    origin: deps.origin,
    identity: deps.identity,
    tracer: deps.tracer,
    credentialStore: deps.credentialStore,
    projectorFactory: () => createAgentProjector({ t: deps.t }),
    mainAgentOnly: deps.mainAgentOnly,
  });
}
