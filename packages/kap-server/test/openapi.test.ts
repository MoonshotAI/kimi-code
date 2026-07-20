/**
 * OpenAPI smoke test for server-v2.
 *
 * Boots the server, fetches `/openapi.json`, and asserts that `@fastify/swagger`
 * is wired and that the v2-specific post-processing transforms ran (as opposed
 * to a verbatim copy of v1's transforms, which would fabricate endpoints v2
 * does not register).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

describe('server-v2 OpenAPI', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function fetchOpenApi(): Promise<Record<string, unknown>> {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-openapi-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/openapi.json`, {
      headers: authHeaders(server),
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    return (await res.json()) as Record<string, unknown>;
  }

  it('returns a valid OpenAPI 3 document', async () => {
    const doc = await fetchOpenApi();

    expect(doc['openapi']).toMatch(/^3\.\d+\.\d+$/);
    const info = asRecord(doc['info']);
    expect(info['title']).toBe('Kimi Code Server API');
    expect(typeof info['version']).toBe('string');
  });

  it('covers the core /api/v1 routes v2 registers', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/healthz']).toBeDefined();
    expect(paths['/api/v1/meta']).toBeDefined();
    expect(paths['/api/v1/sessions']).toBeDefined();
    expect(paths['/api/v1/files']).toBeDefined();
    expect(paths['/api/v1/sessions/{session_id}/fs/{*}']).toBeDefined();
  });

  it('projects the session-action dispatcher into archive only', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    // v2 only registers ::archive — the generic `{tail}` path must be gone and
    // the v1-only actions must not be fabricated.
    expect(paths['/api/v1/sessions/{tail}']).toBeUndefined();
    expect(paths['/api/v1/sessions/{session_id}:archive']).toBeDefined();
    expect(paths['/api/v1/sessions/{session_id}:fork']).toBeUndefined();
    expect(paths['/api/v1/sessions/{session_id}:undo']).toBeUndefined();

    const archiveOp = operation(doc, '/api/v1/sessions/{session_id}:archive', 'post');
    expect(archiveOp['operationId']).toBe('runSessionArchiveAction');
    const params = archiveOp['parameters'] as Array<Record<string, unknown>>;
    expect(params.some((p) => p['in'] === 'path' && p['name'] === 'session_id')).toBe(true);
    expect(params.some((p) => p['name'] === 'tail')).toBe(false);
  });

  it('describes the file upload as multipart/form-data', async () => {
    const doc = await fetchOpenApi();
    const uploadOp = operation(doc, '/api/v1/files', 'post');
    const requestBody = asRecord(uploadOp['requestBody']);
    const content = asRecord(requestBody['content']);
    expect(content['multipart/form-data']).toBeDefined();
  });

  it('describes session export as a ZIP or JSON error envelope', async () => {
    const doc = await fetchOpenApi();
    const exportOp = operation(doc, '/api/v1/sessions/{session_id}/export', 'post');
    const responses = asRecord(exportOp['responses']);
    const response = asRecord(responses['200']);
    const content = asRecord(response['content']);
    const headers = asRecord(response['headers']);
    const zipSchema = asRecord(asRecord(content['application/zip'])['schema']);
    const errorSchema = asRecord(asRecord(content['application/json'])['schema']);
    const errorProperties = asRecord(errorSchema['properties']);

    expect(zipSchema).toMatchObject({ type: 'string', format: 'binary' });
    expect(errorProperties).toMatchObject({
      code: expect.any(Object),
      msg: expect.any(Object),
      data: expect.any(Object),
      request_id: expect.any(Object),
    });
    expect(headers['content-disposition']).toBeDefined();
    expect(headers['content-length']).toBeDefined();
    expect(headers['cache-control']).toBeDefined();
  });

  it('represents the fs-action dispatcher as a oneOf union', async () => {
    const doc = await fetchOpenApi();
    const fsActionOp = operation(doc, '/api/v1/sessions/{session_id}/{tail}', 'post');
    const requestBody = asRecord(fsActionOp['requestBody']);
    const content = asRecord(requestBody['content']);
    const json = asRecord(content['application/json']);
    const schema = asRecord(json['schema']);
    expect(Array.isArray(schema['oneOf'])).toBe(true);
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}

function operation(
  doc: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> {
  const paths = asRecord(doc['paths']);
  const pathItem = asRecord(paths[path]);
  return asRecord(pathItem[method]);
}
