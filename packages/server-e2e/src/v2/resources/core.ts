/**
 * Core-scope resources — `/api/v2/<resource>:<action>`.
 *
 * Exposes one typed resource per entry in the `CORE` manifest, plus the
 * resource-shape types for reuse by the client.
 */
import type { HttpRpc } from '../transport/http.js';
import { makeResource, type ResourceShape } from '../transport/rpcProxy.js';

import { CORE, type CoreManifest } from './manifest.js';
import type { SessionsPrecise, WorkspacesPrecise } from './types.js';

export type SessionsResource = ResourceShape<CoreManifest['sessions'], SessionsPrecise>;
export type WorkspacesResource = ResourceShape<CoreManifest['workspaces'], WorkspacesPrecise>;
export type ConfigResource = ResourceShape<CoreManifest['config']>;
export type ProvidersResource = ResourceShape<CoreManifest['providers']>;
export type OAuthResource = ResourceShape<CoreManifest['oauth']>;
export type AuthResource = ResourceShape<CoreManifest['auth']>;
export type FlagsResource = ResourceShape<CoreManifest['flags']>;
export type PluginsResource = ResourceShape<CoreManifest['plugins']>;
export type CoreFsResource = ResourceShape<CoreManifest['fs']>;
export type MetaResource = ResourceShape<CoreManifest['meta']>;

/** The core-scope resource tree exposed on `ServerClient`. */
export interface CoreResources {
  readonly sessions: SessionsResource;
  readonly workspaces: WorkspacesResource;
  readonly config: ConfigResource;
  readonly providers: ProvidersResource;
  readonly oauth: OAuthResource;
  readonly auth: AuthResource;
  readonly flags: FlagsResource;
  readonly plugins: PluginsResource;
  readonly fs: CoreFsResource;
  readonly meta: MetaResource;
}

export function createCoreResources(rpc: HttpRpc): CoreResources {
  return {
    sessions: makeResource<CoreManifest['sessions'], SessionsPrecise>(
      rpc,
      'core',
      {},
      'sessions',
      CORE.sessions,
    ),
    workspaces: makeResource<CoreManifest['workspaces'], WorkspacesPrecise>(
      rpc,
      'core',
      {},
      'workspaces',
      CORE.workspaces,
    ),
    config: makeResource(rpc, 'core', {}, 'config', CORE.config),
    providers: makeResource(rpc, 'core', {}, 'providers', CORE.providers),
    oauth: makeResource(rpc, 'core', {}, 'oauth', CORE.oauth),
    auth: makeResource(rpc, 'core', {}, 'auth', CORE.auth),
    flags: makeResource(rpc, 'core', {}, 'flags', CORE.flags),
    plugins: makeResource(rpc, 'core', {}, 'plugins', CORE.plugins),
    fs: makeResource(rpc, 'core', {}, 'fs', CORE.fs),
    meta: makeResource(rpc, 'core', {}, 'meta', CORE.meta),
  };
}
