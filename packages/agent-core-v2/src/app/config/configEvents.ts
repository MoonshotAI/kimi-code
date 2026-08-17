/**
 * `config` domain — the App-scope config fact `Event2` classes broadcast on
 * `IEventService`.
 *
 * Both are published by the server edge (kap-server), not by core services:
 * `ConfigWarning` carries the current config-warning set (deprecated keys /
 * env vars in use, invalid sections) whenever the diagnostics change, and
 * `ConfigChanged` announces a config update accepted by the config route,
 * carrying the changed field names and the wire config response the edge
 * just returned — core never owns that response's shape, so `config` stays
 * opaque here. Never persisted; consumers read the `payload` bag.
 * Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { Event2 } from '#/app/event/event2';

export interface ConfigWarningItem {
  readonly domain?: string;
  readonly message: string;
}

export interface ConfigWarningPayload {
  readonly warnings: readonly ConfigWarningItem[];
}

export class ConfigWarning extends Event2<{ readonly payload: ConfigWarningPayload }> {
  static override readonly type = 'event.config.warning';
}
export interface ConfigWarning {
  readonly payload: ConfigWarningPayload;
}

export interface ConfigChangedPayload {
  readonly changedFields: readonly string[];
  readonly config: unknown;
}

export class ConfigChanged extends Event2<{ readonly payload: ConfigChangedPayload }> {
  static override readonly type = 'event.config.changed';
}
export interface ConfigChanged {
  readonly payload: ConfigChangedPayload;
}
