/**
 * Typed proxy turning an `IChannel` (bound to one Service) into a value
 * satisfying that Service's interface `T`.
 *
 * Members named `onUpperCase` become channel events; every other property access
 * becomes a function forwarding its complete argument array to `channel.call`.
 * This is VS Code's `ProxyChannel.toService`: the shared interface `T` is the
 * whole contract, with no per-method allowlist or renaming.
 */

import type { IChannel } from './channel.js';

export function makeProxy<T extends object>(channel: IChannel): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (/^on[A-Z]/.test(prop)) return channel.listen(prop);
      return (...args: unknown[]) => channel.call(prop, args);
    },
  });
}
