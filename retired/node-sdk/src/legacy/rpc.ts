/**
 * Local port of agent-core v1's in-process RPC channel + abort helpers,
 * copied verbatim so node-sdk's RPC utilities work without the retired
 * `@moonshot-ai/agent-core` package:
 * - `src/rpc/client.ts` — createRPC / RPCMethods / RPCCallOptions / RPCClient
 * - `src/rpc/types.ts` — WithAgentId / WithSessionId
 * - `src/utils/types.ts` — PromisableMethods / Promisify / Promisable
 * - `src/utils/abort.ts` — abortable / abortError / abortReason
 *
 * Import rewrites: `#/errors` → `./errors`, `#/flags` flag read dropped
 * (the `rpc_microtask` flag default is `false`; see below), `#/i18n` →
 * `@moonshot-ai/kimi-i18n`.
 */
import { createControlledPromise, objectMap } from '@antfu/utils';
import { t } from '@moonshot-ai/kimi-i18n';

import { fromKimiErrorPayload, toKimiErrorPayload, type KimiErrorPayload } from './errors';

export type Promisify<T> = [T] extends [Promise<any>] ? T : Promise<T>;
export type PromisifyMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Return
    ? (...args: Args) => Promisify<Return>
    : never;
};

export type Promisable<T> = [T] extends [Promise<any>] ? T | Awaited<T> : T | Promise<T>;
export type PromisableMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Return
    ? (...args: Args) => Promisable<Return>
    : never;
};

export function abortError(message?: string): Error {
  const error = new Error(message ?? t('toolsV2.abort.aborted'));
  error.name = 'AbortError';
  return error;
}

export function isDefaultAbortReason(reason: Error): boolean {
  // DOMException with name 'AbortError' is always the default browser/node
  // abort reason — its message is fixed to "This operation was aborted"
  // regardless of locale. Check by constructor name rather than the localized
  // message for cross-locale correctness.
  return reason.name === 'AbortError' && reason.constructor.name === 'DOMException';
}

export function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && !isDefaultAbortReason(signal.reason)) {
    return signal.reason;
  }
  return abortError();
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type WithExtraPayload<T, U> = {
  [K in keyof T]: T[K] extends (payload: infer P) => infer R
    ? (payload: Prettify<P & U>) => R
    : never;
};

export type WithAgentId<T> = WithExtraPayload<T, { readonly agentId: string }>;
export type WithSessionId<T> = WithExtraPayload<T, { readonly sessionId: string }>;

export interface RPCCallOptions {
  signal?: AbortSignal;
}

type RpcResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: KimiErrorPayload };

export type RPCMethods<T> = {
  [K in keyof T]: T[K] extends (payload: infer Payload) => infer Return
    ? (payload: Payload, options?: RPCCallOptions) => Promisify<Return>
    : never;
};

export type RPCClient<Self extends Record<string, any>, Other extends Record<string, any>> = (
  self: PromisableMethods<Self>,
) => Promise<RPCMethods<Other>>;

export function createRPC<Left extends Record<string, any>, Right extends Record<string, any>>(): [
  RPCClient<Left, Right>,
  RPCClient<Right, Left>,
] {
  const left = createControlledPromise<PromisableMethods<Left>>();
  const right = createControlledPromise<PromisableMethods<Right>>();

  // agent-core read an env-driven `rpc_microtask` flag here; the flag defaulted
  // to false, so the local port keeps the setTimeout(0) scheduling.
  const useMicrotask = false;

  function simulateNetwork<T>(data: T): Promise<T> {
    return new Promise((resolve) => {
      const run = (): void => {
        const serialized = JSON.stringify(data);
        resolve(serialized === undefined ? (undefined as T) : JSON.parse(serialized));
      };
      if (useMicrotask) {
        queueMicrotask(run);
      } else {
        setTimeout(run, 0);
      }
    });
  }

  function abortableRpc<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    return signal === undefined ? promise : abortable(promise, signal);
  }

  function mapRpcFunction(fn: Function): Function {
    return async (payload: any, options?: RPCCallOptions) => {
      const signal = options?.signal;
      const rpcPayload = await simulateNetwork(payload);
      signal?.throwIfAborted();
      let response: RpcResponse;
      try {
        const handlerResult =
          signal === undefined ? fn(rpcPayload) : fn(rpcPayload, { signal });
        const value = await abortableRpc(Promise.resolve(handlerResult), signal);
        response = { ok: true, value };
      } catch (error) {
        signal?.throwIfAborted();
        response = { ok: false, error: toKimiErrorPayload(error) };
      }
      const remoteResponse = await simulateNetwork(response);
      if (remoteResponse.ok) return remoteResponse.value;
      throw fromKimiErrorPayload(remoteResponse.error);
    };
  }

  function bindAllFunctions<T extends Record<string, any>>(obj: T): T {
    const bound: Record<string, unknown> = {};
    let current: object | null = obj;

    while (current !== null && current !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(current)) {
        if (key === 'constructor' || Object.hasOwn(bound, key)) {
          continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (typeof descriptor?.value === 'function') {
          bound[key] = descriptor.value.bind(obj);
        }
      }

      current = Object.getPrototypeOf(current);
    }

    return bound as T;
  }

  async function leftClient(self: PromisableMethods<Left>): Promise<RPCMethods<Right>> {
    left.resolve(bindAllFunctions(self));
    return objectMap(await right, (key, fn) => [key, mapRpcFunction(fn)]) as RPCMethods<Right>;
  }

  async function rightClient(self: PromisableMethods<Right>): Promise<RPCMethods<Left>> {
    right.resolve(bindAllFunctions(self));
    return objectMap(await left, (key, fn) => [key, mapRpcFunction(fn)]) as RPCMethods<Left>;
  }

  return [leftClient, rightClient];
}
