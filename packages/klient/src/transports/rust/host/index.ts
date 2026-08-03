/**
 * Host-side service assembly for the rust transport. Each service group with
 * host-side work exports a builder (from node-sdk's exported host layer /
 * `@moonshot-ai/kimi-code-oauth` / local ports); this module assembles the
 * bag `createKlientFromRust` hands to every call context.
 *
 * Group builders are imported here (added as groups land) — service modules
 * must not import this file to avoid cycles; they read `ctx.host['<key>']`.
 */

import type { RustHostServices } from '../types.js';

// Group host builders (added by each service group as it lands):
// import { buildConfigHost } from './config.js';        // G1 → host.config
// import { buildAuthHost } from './auth.js';            // G3 → host.auth
// import { buildFlagsCatalogHost } from './flagsCatalog.js'; // G4 → host.flags + host.catalog
// import { buildFsWorkspacesPluginsHost } from './fsWorkspacesPlugins.js'; // G5 → host.fs/workspaces/plugins

export function buildHostServices(options: {
  readonly homeDir: string;
  readonly configPath: string;
}): RustHostServices {
  return {
    homeDir: options.homeDir,
    configPath: options.configPath,
    // config: buildConfigHost(options),            // G1
    // auth: buildAuthHost(options),                // G3
    // flags: ..., catalog: ...,                    // G4
    // fs: ..., workspaces: ..., plugins: ...,      // G5
  };
}
