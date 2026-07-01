/**
 * Host-header allowlist middleware for DNS-rebinding protection.
 */

import { isIP } from 'node:net';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope } from '../envelope';

const HOST_ERROR_CODE = 40301;

export interface HostCheckOptions {
  readonly boundHost?: string;
  readonly extra?: readonly string[];
  readonly disable?: boolean;
}

export interface HostCheck {
  readonly onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;
  readonly isAllowed: (host: string | undefined) => boolean;
}

export function parseAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['KIMI_CODE_ALLOWED_HOSTS'];
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isHostCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['KIMI_CODE_DISABLE_HOST_CHECK'] === '1';
}

export function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return (end === -1 ? host : host.slice(0, end + 1)).toLowerCase();
  }
  const firstColon = host.indexOf(':');
  if (firstColon === -1) {
    return host.toLowerCase();
  }
  const lastColon = host.lastIndexOf(':');
  if (firstColon === lastColon) {
    const after = host.slice(lastColon + 1);
    if (after.length > 0 && /^\d+$/.test(after)) {
      return host.slice(0, lastColon).toLowerCase();
    }
  }
  return host.toLowerCase();
}

export function formatHostErrorMessage(host: string | undefined): string {
  const normalizedHost = host === undefined || host.length === 0 ? undefined : stripPort(host);
  const hostLabel = normalizedHost ?? '<missing>';
  const hostArg = normalizedHost ?? '<host>';
  return `Invalid Host header: ${hostLabel}; allow this host with KIMI_CODE_ALLOWED_HOSTS=${hostArg} or 'kimi server run --allowed-host ${hostArg}'.`;
}

export function isAllowedHost(host: string | undefined, opts: HostCheckOptions): boolean {
  if (opts.disable === true) {
    return true;
  }
  if (host === undefined || host.length === 0) {
    return false;
  }
  const h = stripPort(host);

  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') {
    return true;
  }
  if (h.endsWith('.localhost')) {
    return true;
  }
  if (isIP(h) !== 0) {
    return true;
  }
  if (opts.boundHost !== undefined && h === stripPort(opts.boundHost)) {
    return true;
  }
  if (opts.extra !== undefined) {
    for (const entry of opts.extra) {
      if (entry.startsWith('.')) {
        const base = entry.slice(1);
        if (h === base || h.endsWith(entry)) {
          return true;
        }
      } else if (h === entry) {
        return true;
      }
    }
  }
  return false;
}

export function createHostCheck(opts: HostCheckOptions): HostCheck {
  const isAllowed = (host: string | undefined): boolean => isAllowedHost(host, opts);
  const onRequest = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> => {
    if (!isAllowed(req.headers.host)) {
      return reply.code(403).send(errEnvelope(HOST_ERROR_CODE, formatHostErrorMessage(req.headers.host), req.id));
    }
  };
  return { onRequest, isAllowed };
}
