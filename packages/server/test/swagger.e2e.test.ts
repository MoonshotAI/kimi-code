/**
 * OpenAPI smoke test.
 *
 * Asserts that `@fastify/swagger` is wired correctly and that the generated
 * OpenAPI document covers the server's REST surface.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-swagger-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-swagger-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown; payload: string }>;
} {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown; payload: string }>;
};
  });
  // Auto-attach the fixed bearer token so the M5.1 auth hook passes. A
  // caller-supplied `authorization` header wins, so explicit token tests keep
  // working; every other header (Range, content-type, …) is preserved.
  return {
    inject(req: unknown) {
      const q = req as { headers?: Record<string, string | string[] | undefined> };
      return app.inject({
        ...q,
        headers: { authorization: 'Bearer test-token', ...q.headers },
      });
    },
  };
}

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

function requestJsonSchema(
  doc: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> {
  const requestBody = asRecord(operation(doc, path, method)['requestBody']);
  const content = asRecord(requestBody['content']);
  const json = asRecord(content['application/json']);
  return asRecord(json['schema']);
}

function responseJsonSchema(
  doc: Record<string, unknown>,
  path: string,
  method: string,
  status = '200',
): Record<string, unknown> {
  const responses = asRecord(operation(doc, path, method)['responses']);
  const response = asRecord(responses[status]);
  const content = asRecord(response['content']);
  const json = asRecord(content['application/json']);
  return asRecord(json['schema']);
}

function schemaWithProperties(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema['properties'] !== undefined) return schema;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const record = asRecord(variant);
      if (record['properties'] !== undefined) return record;
    }
  }
  throw new Error('expected schema with properties');
}

describe('Swagger / OpenAPI', () => {
  it('/openapi.json returns a valid OpenAPI document', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);

    const doc = res.json() as Record<string, unknown>;
    expect(doc['openapi']).toMatch(/^3\.\d+\.\d+$/);
    expect(typeof doc['info']).toBe('object');
    expect((doc['info'] as Record<string, unknown>)['title']).toBe('Kimi Code Server API');
    expect(typeof (doc['info'] as Record<string, unknown>)['version']).toBe('string');

    const paths = doc['paths'] as Record<string, unknown>;
    expect(paths['/api/v1/healthz']).toBeDefined();
    expect(paths['/api/v1/meta']).toBeDefined();
    expect(paths['/api/v1/sessions']).toBeDefined();
    expect(paths['/api/v1/sessions/{tail}']).toBeUndefined();
    expect(paths['/api/v1/tools']).toBeDefined();
    expect(paths['/api/v1/files']).toBeDefined();

    const createSessionRequest = requestJsonSchema(doc, '/api/v1/sessions', 'post');
    expect(asRecord(createSessionRequest['properties'])['metadata']).toBeDefined();

    const metaResponse = responseJsonSchema(doc, '/api/v1/meta', 'get');
    const metaProperties = asRecord(metaResponse['properties']);
    expect(metaProperties['code']).toBeDefined();
    expect(metaProperties['msg']).toBeDefined();
    expect(metaProperties['request_id']).toBeDefined();
    const metaDataProperties = asRecord(schemaWithProperties(asRecord(metaProperties['data']))['properties']);
    expect(metaDataProperties['server_version']).toBeDefined();

    const listSessionsResponse = responseJsonSchema(doc, '/api/v1/sessions', 'get');
    // Sessions list route now declares error variants → response is a oneOf.
    // Unwrap via schemaWithProperties to reach the envelope shape.
    const listSessionsEnvelope = schemaWithProperties(listSessionsResponse);
    const listSessionData = schemaWithProperties(asRecord(asRecord(listSessionsEnvelope['properties'])['data']));
    expect(asRecord(listSessionData['properties'])['items']).toBeDefined();

    const forkOp = operation(doc, '/api/v1/sessions/{session_id}:fork', 'post');
    const forkParams = forkOp['parameters'] as Array<Record<string, unknown>>;
    expect(forkParams.some((p) => p['in'] === 'path' && p['name'] === 'session_id')).toBe(true);
    expect(forkParams.some((p) => p['name'] === 'tail')).toBe(false);
    const forkRequest = requestJsonSchema(doc, '/api/v1/sessions/{session_id}:fork', 'post');
    expect(asRecord(forkRequest['properties'])['metadata']).toBeDefined();
    const forkResponse = responseJsonSchema(doc, '/api/v1/sessions/{session_id}:fork', 'post');
    expect(Array.isArray(forkResponse['oneOf'])).toBe(true);

    const undoOp = operation(doc, '/api/v1/sessions/{session_id}:undo', 'post');
    const undoParams = undoOp['parameters'] as Array<Record<string, unknown>>;
    expect(undoParams.some((p) => p['in'] === 'path' && p['name'] === 'session_id')).toBe(true);
    expect(undoParams.some((p) => p['name'] === 'tail')).toBe(false);
    const undoRequest = requestJsonSchema(doc, '/api/v1/sessions/{session_id}:undo', 'post');
    expect(asRecord(undoRequest['properties'])['count']).toBeDefined();
    const undoResponse = responseJsonSchema(doc, '/api/v1/sessions/{session_id}:undo', 'post');
    const undoResponseEnvelope = schemaWithProperties(undoResponse);
    const undoData = schemaWithProperties(
      asRecord(asRecord(undoResponseEnvelope['properties'])['data']),
    );
    expect(asRecord(undoData['properties'])['messages']).toBeDefined();

    const listChildrenResponse = responseJsonSchema(
      doc,
      '/api/v1/sessions/{session_id}/children',
      'get',
    );
    const listChildrenEnvelope = schemaWithProperties(listChildrenResponse);
    const listChildrenData = schemaWithProperties(
      asRecord(asRecord(listChildrenEnvelope['properties'])['data']),
    );
    expect(asRecord(listChildrenData['properties'])['items']).toBeDefined();
    const listChildrenParams = operation(
      doc,
      '/api/v1/sessions/{session_id}/children',
      'get',
    )['parameters'] as Array<Record<string, unknown>>;
    expect(listChildrenParams.some((p) => p['name'] === 'workspace_id')).toBe(false);
    const createChildRequest = requestJsonSchema(
      doc,
      '/api/v1/sessions/{session_id}/children',
      'post',
    );
    expect(asRecord(createChildRequest['properties'])['metadata']).toBeDefined();

    const uploadOp = operation(doc, '/api/v1/files', 'post');
    const uploadRequestBody = asRecord(uploadOp['requestBody']);
    expect(asRecord(asRecord(uploadRequestBody['content'])['multipart/form-data'])).toBeDefined();

    const downloadResponse = asRecord(
      asRecord(asRecord(operation(doc, '/api/v1/files/{file_id}', 'get')['responses'])['200'])['content'],
    );
    expect(asRecord(asRecord(downloadResponse['application/octet-stream'])['schema'])['format']).toBe('binary');

    const fsActionRequest = requestJsonSchema(doc, '/api/v1/sessions/{session_id}/{tail}', 'post');
    expect(Array.isArray(fsActionRequest['oneOf'])).toBe(true);
    const fsActionResponse = responseJsonSchema(doc, '/api/v1/sessions/{session_id}/{tail}', 'post');
    expect(Array.isArray(fsActionResponse['oneOf'])).toBe(true);

    const questionOp = operation(doc, '/api/v1/sessions/{session_id}/questions/{tail}', 'post');
    expect(asRecord(questionOp['requestBody'])['required']).toBe(false);
    const questionResponse = responseJsonSchema(doc, '/api/v1/sessions/{session_id}/questions/{tail}', 'post');
    expect(Array.isArray(questionResponse['oneOf'])).toBe(true);

    // Prompts submit route (defineRoute) — response should be a oneOf union
    // covering success (code:0) and declared error codes.
    const promptsResponse = responseJsonSchema(doc, '/api/v1/sessions/{session_id}/prompts', 'post');
    expect(Array.isArray(promptsResponse['oneOf'])).toBe(true);
    const promptVariants = promptsResponse['oneOf'] as Array<Record<string, unknown>>;
    expect(promptVariants.length).toBeGreaterThanOrEqual(2);
    const promptCodes = promptVariants.map((v) => {
      const props = asRecord(v['properties']);
      const code = asRecord(props['code']);
      return (code['enum'] as number[] | undefined)?.[0] ?? code['const'];
    });
    expect(promptCodes[0]).toBe(0);
    expect(promptCodes).toContain(40001);
    expect(promptCodes).toContain(40401);
  });
});
