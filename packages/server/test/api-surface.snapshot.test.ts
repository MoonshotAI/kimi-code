/**
 * API surface snapshot for the server's `/api/v1` Fastify route table.
 *
 * Builds a minimal Fastify instance, registers the REAL route table via
 * `registerApiV1Routes` (the same entry used by `start.ts`) with a stub DI
 * container, and captures every registered route's `{ method, url, schemaSummary }`
 * through Fastify's `onRoute` hook. The result is sorted deterministically and
 * compared against the committed snapshot, so any route add/remove/rename or
 * request/response schema change fails this test until the snapshot is updated.
 *
 * No HTTP server is started and no backend services are connected: route
 * modules resolve services lazily inside their handlers, so registration never
 * touches the stub container.
 */

import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import type { IInstantiationService } from '@moonshot-ai/agent-core';
import { describe, expect, it } from 'vitest';

import { registerApiV1Routes } from '../src/routes/registerApiV1Routes.js';

/**
 * Compact, deterministic summary of one JSON-schema request part
 * (body / params / querystring). Captures shape-changing fields (type,
 * required keys, property names) without dumping the whole schema.
 */
interface SchemaPartSummary {
  readonly type: string | readonly string[] | null;
  readonly required: readonly string[];
  readonly properties: readonly string[];
}

/** Compact summary of a route's request + response schema. */
interface SchemaSummary {
  readonly body: SchemaPartSummary | null;
  readonly params: SchemaPartSummary | null;
  readonly querystring: SchemaPartSummary | null;
  /** Map of response status code -> compact descriptor of that schema. */
  readonly responses: Readonly<Record<string, string>>;
}

interface RouteSurfaceEntry {
  readonly method: string;
  readonly url: string;
  readonly schemaSummary: SchemaSummary;
}

function summarizePart(schema: unknown): SchemaPartSummary | null {
  if (schema === null || typeof schema !== 'object') {
    return null;
  }
  const obj = schema as Record<string, unknown>;
  const rawType = obj['type'];
  const type =
    typeof rawType === 'string'
      ? rawType
      : Array.isArray(rawType) && rawType.every((t): t is string => typeof t === 'string')
        ? [...rawType].sort()
        : null;

  const rawRequired = obj['required'];
  const required =
    Array.isArray(rawRequired) && rawRequired.every((r): r is string => typeof r === 'string')
      ? [...rawRequired].sort()
      : [];

  const rawProps = obj['properties'];
  const properties =
    rawProps !== null && typeof rawProps === 'object' && !Array.isArray(rawProps)
      ? Object.keys(rawProps as Record<string, unknown>).sort()
      : [];

  return { type, required, properties };
}

function describeResponseSchema(schema: unknown): string {
  if (schema === null || typeof schema !== 'object') {
    return 'none';
  }
  const obj = schema as Record<string, unknown>;
  if (Array.isArray(obj['oneOf'])) {
    return `oneOf(${(obj['oneOf'] as unknown[]).length})`;
  }
  if (Array.isArray(obj['anyOf'])) {
    return `anyOf(${(obj['anyOf'] as unknown[]).length})`;
  }
  const rawType = obj['type'];
  if (typeof rawType === 'string') {
    return `type:${rawType}`;
  }
  return 'other';
}

function summarizeResponses(schema: unknown): Readonly<Record<string, string>> {
  if (schema === null || typeof schema !== 'object') {
    return {};
  }
  const out: Record<string, string> = {};
  for (const code of Object.keys(schema as Record<string, unknown>).sort()) {
    out[code] = describeResponseSchema((schema as Record<string, unknown>)[code]);
  }
  return out;
}

function buildSchemaSummary(schema: RouteOptions['schema']): SchemaSummary {
  const s = (schema ?? {}) as Record<string, unknown>;
  return {
    body: summarizePart(s['body']),
    params: summarizePart(s['params']),
    querystring: summarizePart(s['querystring']),
    responses: summarizeResponses(s['response']),
  };
}

async function collectRouteSurface(): Promise<RouteSurfaceEntry[]> {
  const app: FastifyInstance = Fastify({ logger: false });
  // Match start.ts: bypass Fastify's schema compilers so `app.ready()` does
  // not try to compile/validate response schemas (we only need the route table
  // and raw schema objects from the onRoute hook, not runtime serialization).
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  const entries: RouteSurfaceEntry[] = [];

  app.addHook('onRoute', (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      entries.push({
        method: method.toUpperCase(),
        url: route.url,
        schemaSummary: buildSchemaSummary(route.schema),
      });
    }
  });

  const stubIx = null as unknown as IInstantiationService;
  await registerApiV1Routes(app, stubIx, { serverVersion: '0.0.0-snapshot' });
  await app.ready();

  return entries.sort((a, b) =>
    a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url),
  );
}

describe('server API surface snapshot', () => {
  it('matches the registered route surface snapshot', async () => {
    const routes = await collectRouteSurface();
    expect(routes).toMatchSnapshot();
  });
});
