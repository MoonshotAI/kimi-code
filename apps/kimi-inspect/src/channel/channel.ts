import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';

export interface IDisposable {
  dispose(): void;
}

export interface Event<T> {
  (listener: (event: T) => unknown, thisArg?: unknown, disposables?: IDisposable[]): IDisposable;
}

export interface IChannel {
  call<T>(command: string, args?: unknown[]): Promise<T>;
  listen<T>(event: string, arg?: unknown): Event<T>;
}

export type ServiceRef<T> = ServiceIdentifier<T> | string;

export type ServiceProxy<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? R extends IDisposable
      ? T[K]
      : (...args: A) => Promise<Awaited<R>>
    : () => Promise<Awaited<T[K]>>;
};
