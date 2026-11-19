import { isIPv4, Socket } from 'node:net';

import { TestkitError } from '#/errors';

export interface NetworkGuard {
  violations(): readonly string[];
  assertNoViolations(): void;
  uninstall(): void;
}

export interface NetworkGuardOptions {
  readonly allowHosts?: readonly string[];
}

type Connect = (this: Socket, ...args: unknown[]) => Socket;

interface InstalledGuard {
  readonly original: Connect;
  readonly violations: string[];
  readonly allowHosts: Set<string>;
  users: number;
}

let installed: InstalledGuard | undefined;

export function installNetworkGuard(options: NetworkGuardOptions = {}): NetworkGuard {
  const guard = installed ?? install();
  for (const host of options.allowHosts ?? []) guard.allowHosts.add(host.toLowerCase());
  guard.users += 1;
  let active = true;
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
      if (!active) return;
      active = false;
      guard.users -= 1;
      if (guard.users > 0) return;
      Socket.prototype.connect = guard.original as typeof Socket.prototype.connect;
      installed = undefined;
    },
  };
}

function install(): InstalledGuard {
  const descriptor = Object.getOwnPropertyDescriptor(Socket.prototype, 'connect');
  const original = descriptor?.value as Connect;
  const guard: InstalledGuard = { original, violations: [], allowHosts: new Set(), users: 0 };
  const patched: Connect = function guardedConnect(this: Socket, ...args: unknown[]): Socket {
    const target = targetOf(args);
    if (target === undefined || isLoopback(target.host) || guard.allowHosts.has(target.host.toLowerCase())) {
      return Reflect.apply(original, this, args) as Socket;
    }
    const description = `${target.host}:${target.port ?? '?'}`;
    guard.violations.push(description);
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

function targetOf(args: readonly unknown[]): Target | undefined {
  const first = Array.isArray(args[0]) ? (args[0] as readonly unknown[])[0] : args[0];
  if (typeof first === 'string') return undefined;
  if (typeof first === 'number') {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return { host, port: first };
  }
  if (typeof first !== 'object' || first === null) return undefined;
  const options = first as { readonly host?: unknown; readonly port?: unknown; readonly path?: unknown };
  if (typeof options.path === 'string') return undefined;
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
