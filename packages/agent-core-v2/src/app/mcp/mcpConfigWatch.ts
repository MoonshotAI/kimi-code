/**
 * `mcp` domain (L5) — App-scope watch contract for the user-level mcp.json.
 *
 * Defines `IMcpConfigWatchService`: a typed `onDidChange` event that fires
 * when the user-global `<homeDir>/mcp.json` changes on disk and its new
 * content parses (blank content counts as valid, matching the loader). Only
 * the user level is watched — project-root `.mcp.json` and project-local
 * `.kimi-code/mcp.json` are per-workspace paths and stay unwatched this
 * round. v2 has no mcp.json writer (edits are out-of-band direct writes) and
 * no server-config cache yet, so the event exists for future hot-aware
 * consumers; Session-scoped services may subscribe to this App-scope event,
 * never the reverse. Bound at App scope.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IMcpConfigWatchService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
}

export const IMcpConfigWatchService: ServiceIdentifier<IMcpConfigWatchService> =
  createDecorator<IMcpConfigWatchService>('mcpConfigWatchService');
