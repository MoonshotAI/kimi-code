/**
 * Typed proxy turning an `IChannel` (bound to one Service) into a value
 * satisfying that Service's interface `T` — VS Code's `ProxyChannel.toService`.
 *
 * Members named `onUpperCase` become channel events; every other property access
 * becomes a function forwarding its complete argument array to `channel.call`
 * (the dispatcher also answers property reads this way). The shared interface
 * `T` is the whole contract, with no per-method allowlist or renaming.
 */

import type { IChannel, ServiceProxy } from './channel';

export function makeProxy<T extends object>(channel: IChannel): ServiceProxy<T> {
  return new Proxy({} as ServiceProxy<T>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (/^on[A-Z]/.test(prop)) return channel.listen(prop);
      return (...args: unknown[]) => channel.call(prop, args);
    },
  });
}
