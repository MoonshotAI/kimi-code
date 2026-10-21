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
