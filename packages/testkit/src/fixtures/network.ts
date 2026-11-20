import { isIPv4, Socket } from 'node:net';

import { TestkitError } from '#/errors';

export interface NetworkGuard {
  violations(): readonly string[];
  assertNoViolations(): void;
  uninstall(): void;
}

export interface NetworkGuardOptions {
  readonly allowHosts?: readonly string[];
  readonly onViolation?: (target: string) => void;
}

export const NETWORK_LOG_ENV = 'TESTKIT_NETWORK_LOG';
export const FETCH_STUBS_ENV = 'TESTKIT_FETCH_STUBS';
export const NETWORK_GUARD_PRELOAD = new URL('./network-preload.ts', import.meta.url);

export interface FetchStub {
  readonly method: string;
  readonly url: string;
  readonly status: number;
}

export function networkGuardEnv(log: string, stubs: readonly FetchStub[] = []): Record<string, string> {
  return { [NETWORK_LOG_ENV]: log, ...(stubs.length === 0 ? {} : { [FETCH_STUBS_ENV]: JSON.stringify(stubs) }) };
}

type Connect = (this: Socket, ...args: unknown[]) => Socket;

interface InstalledGuard {
  readonly original: Connect;
  readonly violations: string[];
  readonly scopes: { hosts: ReadonlySet<string>; onViolation?: (target: string) => void }[];
}

let installed: InstalledGuard | undefined;

export function installNetworkGuard(options: NetworkGuardOptions = {}): NetworkGuard {
  const guard = installed ?? install();
  const allowHosts = new Set(options.allowHosts?.map((host) => host.toLowerCase()));
  const scope = { hosts: allowHosts, onViolation: options.onViolation };
  guard.scopes.push(scope);
  return {
    violations: () => [...guard.violations],
    assertNoViolations: () => {
      if (guard.violations.length === 0) return;
      throw new TestkitError(
        [
          `The test tried to reach ${guard.violations.length} non-loopback address(es); tests must stay offline:`,
          ...guard.violations.map((violation) => `- ${violation}`),
          'Point the code under test at a fake (for example the testkit fake model) instead of a real service.',
        ].join('\n'),
      );
    },
    uninstall: () => {
      const index = guard.scopes.indexOf(scope);
      if (index < 0) return;
      guard.scopes.splice(index, 1);
      if (guard.scopes.length > 0) return;
      Socket.prototype.connect = guard.original as typeof Socket.prototype.connect;
      installed = undefined;
    },
  };
}

function install(): InstalledGuard {
  const descriptor = Object.getOwnPropertyDescriptor(Socket.prototype, 'connect');
  const original = descriptor?.value as Connect;
  const guard: InstalledGuard = { original, violations: [], scopes: [] };
  const patched: Connect = function guardedConnect(this: Socket, ...args: unknown[]): Socket {
    const target = tcpTargetOf(args);
    if (target === undefined || isLoopback(target.host) || guard.scopes.some(({ hosts }) => hosts.has(target.host.toLowerCase()))) {
      return Reflect.apply(original, this, args) as Socket;
    }
    const description = `${target.host}:${target.port ?? '?'}`;
    guard.violations.push(description);
    for (const scope of guard.scopes) scope.onViolation?.(description);
    process.nextTick(() => {
      this.destroy(Object.assign(new Error(`testkit network guard blocked a connection to ${description}`), { code: 'ECONNREFUSED' }));
    });
    return this;
  };
  Socket.prototype.connect = patched as typeof Socket.prototype.connect;
  installed = guard;
  return guard;
}

interface Target {
  readonly host: string;
  readonly port?: number | string;
}

export function tcpTargetOf(args: readonly unknown[]): Target | undefined {
  const first = Array.isArray(args[0]) ? (args[0] as readonly unknown[])[0] : args[0];
  if (typeof first === 'string' || typeof first === 'number') {
    if (typeof first === 'string') {
      const port = Number(first);
      if (first.trim() === '' || !Number.isInteger(port) || port < 0 || port > 65535) return undefined;
    }
    const host = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost';
    return { host, port: first };
  }
  if (typeof first !== 'object' || first === null) return undefined;
  const options = first as { readonly host?: unknown; readonly port?: unknown; readonly path?: unknown };
  if (typeof options.path === 'string' && options.path !== '') return undefined;
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : 'localhost';
  const port = typeof options.port === 'number' || typeof options.port === 'string' ? options.port : undefined;
  return { host, port };
}

export function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    (host.startsWith('127.') && isIPv4(host)) ||
    normalized === '::ffff:127.0.0.1'
  );
}
