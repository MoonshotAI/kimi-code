import { describe, expect, it } from 'vitest';

import { sharedAuthHeaders, sharedServer } from './helpers/sharedServer';

describe('server-v2 OpenAPI', () => {
  async function fetchOpenApi(): Promise<Record<string, unknown>> {
    const res = await fetch(`${sharedServer().base}/openapi.json`, {
      headers: sharedAuthHeaders(),
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

  it('projects every session action onto its own path', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/sessions/{tail}']).toBeUndefined();
    const operationIds = {
      fork: 'runSessionForkAction',
      compact: 'runSessionCompactAction',
      undo: 'runSessionUndoAction',
      cancel: 'runSessionCancelAction',
      wait: 'runSessionWaitAction',
      continue: 'runSessionContinueAction',
      btw: 'runSessionBtwAction',
      restore: 'runSessionRestoreAction',
      archive: 'runSessionArchiveAction',
      delete: 'runSessionDeleteAction',
      reload: 'runSessionReloadAction',
      takeover: 'runSessionTakeoverAction',
    };
    for (const [action, operationId] of Object.entries(operationIds)) {
      const op = operation(doc, `/api/v1/sessions/{session_id}:${action}`, 'post');
      expect(op['operationId']).toBe(operationId);
      const params = op['parameters'] as Array<Record<string, unknown>>;
      expect(params.some((p) => p['in'] === 'path' && p['name'] === 'session_id')).toBe(true);
      expect(params.some((p) => p['name'] === 'tail')).toBe(false);
    }
  });

  it('documents the request body each session action accepts', async () => {
    const doc = await fetchOpenApi();
    const requestBody = (action: string) =>
      operation(doc, `/api/v1/sessions/{session_id}:${action}`, 'post')['requestBody'];
    const bodySchema = (action: string) =>
      asRecord(asRecord(asRecord(asRecord(requestBody(action))['content'])['application/json'])['schema']);

    expect(requestBody('undo')).toMatchObject({ required: true });
    for (const action of ['fork', 'compact', 'cancel', 'wait']) {
      expect(requestBody(action)).toMatchObject({ required: false });
    }
    for (const action of ['continue', 'btw', 'restore', 'archive', 'delete', 'reload', 'takeover']) {
      expect(requestBody(action)).toBeUndefined();
    }

    expect(bodySchema('undo')['required']).toEqual(['turn_id']);
    expect(asRecord(bodySchema('compact')['properties'])['instruction']).toMatchObject({ type: 'string' });
    const cancelProps = asRecord(bodySchema('cancel')['properties']);
    expect(cancelProps['agent_id']).toMatchObject({ type: 'string' });
    expect(cancelProps['include_background']).toMatchObject({ type: 'boolean' });
  });

  it('documents the data :undo returns when the requested turns cannot be undone', async () => {
    const doc = await fetchOpenApi();
    const op = operation(doc, '/api/v1/sessions/{session_id}:undo', 'post');
    const content = asRecord(asRecord(asRecord(op['responses'])['200'])['content']);
    const variants = asRecord(asRecord(content['application/json'])['schema'])['oneOf'] as Array<{
      properties: { code: { enum: number[] }; data: unknown };
    }>;
    const unavailable = variants.find((variant) => variant.properties.code.enum.includes(40911));
    expect(unavailable?.properties.data).toMatchObject({
      type: 'object',
      nullable: true,
      required: ['reason', 'requestedCount', 'undoableCount'],
      properties: { reason: { enum: ['empty', 'compaction_boundary', 'insufficient'] } },
    });
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

  it('documents raw download failures with HTTP error statuses', async () => {
    const doc = await fetchOpenApi();
    for (const [path, method] of [
      ['/api/v1/sessions/{session_id}/fs/{*}', 'get'],
      ['/api/v1/fs:content', 'get'],
    ] as const) {
      const responses = asRecord(operation(doc, path, method)['responses']);
      for (const status of ['400', '403', '404', '409', '413', '500']) {
        const content = asRecord(asRecord(responses[status])['content']);
        expect(asRecord(content['application/json'])).toBeDefined();
      }
    }
  });

  it('documents file-write errors under the HTTP statuses sent by the route', async () => {
    const doc = await fetchOpenApi();
    const responses = asRecord(operation(doc, '/api/v1/fs:content', 'put')['responses']);
    const schemaAt = (status: string) => asRecord(asRecord(asRecord(asRecord(responses[status])['content'])['application/json'])['schema']);
    expect(schemaAt('403')).toMatchObject({ oneOf: [
      { properties: { code: { enum: [40301] } } },
      { properties: { code: { enum: [40302] } } },
    ] });
    for (const [status, code] of [['400', 40001], ['412', 41201], ['413', 41302]] as const) {
      expect(responses[status], `HTTP ${status}`).toBeDefined();
      expect(schemaAt(status)).toMatchObject({ properties: { code: { enum: [code] }, data: { nullable: true } } });
    }
    const okVariants = schemaAt('200')['oneOf'] as Array<{ properties: { code: { enum: number[] } } }>;
    expect(okVariants.flatMap(variant => variant.properties.code.enum)).toEqual([0, 40001, 50001]);
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

  it('documents MCP OAuth failures for auth completion under /api/v1/mcp', async () => {
    const doc = await fetchOpenApi();
    const paths = Object.keys(asRecord(doc['paths']));
    expect(paths.some((path) => path.startsWith('/api/v2/'))).toBe(false);
    const authCompleteOp = operation(doc, '/api/v1/mcp/auth:complete', 'post');
    const responses = asRecord(authCompleteOp['responses']);
    const response = asRecord(responses['200']);
    const content = asRecord(response['content']);
    const schema = asRecord(asRecord(content['application/json'])['schema']);
    const variants = schema['oneOf'];

    expect(Array.isArray(variants)).toBe(true);
    expect(
      (variants as unknown[]).some((variant) => {
        const properties = asRecord(asRecord(variant)['properties']);
        const values = asRecord(properties['code'])['enum'];
        return Array.isArray(values) && values.includes(40929);
      }),
    ).toBe(true);
  });

  it('documents the Tower mode failure on the profile route', async () => {
    const doc = await fetchOpenApi();
    const op = operation(doc, '/api/v1/sessions/{session_id}/profile', 'post');
    const content = asRecord(asRecord(asRecord(op['responses'])['200'])['content']);
    const variants = asRecord(asRecord(content['application/json'])['schema'])['oneOf'];
    expect(
      (variants as unknown[]).some((variant) => {
        const values = asRecord(asRecord(asRecord(variant)['properties'])['code'])['enum'];
        return Array.isArray(values) && values.includes(40935);
      }),
    ).toBe(true);
  });

  it('documents session conflicts for session mutation routes', async () => {
    const doc = await fetchOpenApi();
    const docPaths = asRecord(doc['paths']);
    expect(docPaths['/api/v1/client-configs/{name}']).toBeUndefined();
    expect(docPaths['/api/v1/client_configs']).toBeUndefined();
    const paths = [
      '/api/v1/sessions/{session_id}/profile',
      '/api/v1/sessions/{session_id}/title/generate',
      '/api/v1/sessions/{session_id}:cancel',
      '/api/v1/sessions/{session_id}/skills/{tail}',
    ];
    for (const path of paths) {
      const op = operation(doc, path, 'post');
      const responses = asRecord(op['responses']);
      const content = asRecord(asRecord(responses['200'])['content']);
      const schema = asRecord(asRecord(content['application/json'])['schema']);
      const variants = schema['oneOf'];
      expect(Array.isArray(variants)).toBe(true);
      for (const code of [40931, 40932]) {
        expect(
          (variants as unknown[]).some((variant) => {
            const properties = asRecord(asRecord(variant)['properties']);
            const values = asRecord(properties['code'])['enum'];
            return Array.isArray(values) && values.includes(code);
          }),
        ).toBe(true);
      }
    }
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
