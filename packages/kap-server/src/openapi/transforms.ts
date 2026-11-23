import {
  fsDiffRequestSchema,
  fsDiffResponseSchema,
  fsGitStatusRequestSchema,
  fsGitStatusResponseSchema,
} from '@moonshot-ai/agent-core-v2/app/git/git';
import {
  fsGrepRequestSchema,
  fsGrepResponseSchema,
  fsListManyRequestSchema,
  fsListManyResponseSchema,
  fsListRequestSchema,
  fsListResponseSchema,
  fsMkdirRequestSchema,
  fsMkdirResponseSchema,
  fsReadRequestSchema,
  fsReadResponseSchema,
  fsSearchRequestSchema,
  fsSearchResponseSchema,
  fsStatManyRequestSchema,
  fsStatManyResponseSchema,
  fsStatRequestSchema,
  fsStatResponseSchema,
} from '@moonshot-ai/agent-core-v2/workspace/workspaceFs/fs';
import { z } from 'zod';

import { buildSuccessEnvelopeSchema } from '../middleware/defineRoute';
import {
  openApiDocumentEnvelopeJsonSchema,
  openApiDocumentJsonSchema,
} from '../middleware/schema';
import {
  fsOpenInRequestSchema,
  fsOpenInResponseSchema,
  fsOpenRequestSchema,
  fsOpenResponseSchema,
  fsRevealRequestSchema,
  fsRevealResponseSchema,
} from '../protocol/rest-fs';
import {
  archiveSessionResponseSchema,
  cancelSessionBodySchema,
  deleteSessionResponseSchema,
  getSessionResponseSchema,
  sessionCancelResponseSchema,
  sessionContinueResponseSchema,
  takeoverSessionResponseSchema,
  waitSessionBodySchema,
  waitSessionResponseSchema,
} from '../protocol/rest-session';

const binarySchema = {
  type: 'string',
  format: 'binary',
} as const;

const fileUploadMultipartSchema = {
  type: 'object',
  properties: {
    file: binarySchema,
    name: { type: 'string' },
    expires_in_sec: { type: 'number', minimum: 0 },
  },
  required: ['file'],
} as const;

const errorEnvelopeSchema = openApiDocumentEnvelopeJsonSchema(z.null());

const fsActionRequestSchema = {
  oneOf: [
    openApiDocumentJsonSchema(fsListRequestSchema),
    openApiDocumentJsonSchema(fsReadRequestSchema),
    openApiDocumentJsonSchema(fsListManyRequestSchema),
    openApiDocumentJsonSchema(fsStatRequestSchema),
    openApiDocumentJsonSchema(fsStatManyRequestSchema),
    openApiDocumentJsonSchema(fsMkdirRequestSchema),
    openApiDocumentJsonSchema(fsSearchRequestSchema),
    openApiDocumentJsonSchema(fsGrepRequestSchema),
    openApiDocumentJsonSchema(fsGitStatusRequestSchema),
    openApiDocumentJsonSchema(fsDiffRequestSchema),
    openApiDocumentJsonSchema(fsOpenRequestSchema),
    openApiDocumentJsonSchema(fsOpenInRequestSchema),
    openApiDocumentJsonSchema(fsRevealRequestSchema),
  ],
} as const;

const fsActionResponseSchema = {
  oneOf: [
    openApiDocumentEnvelopeJsonSchema(fsListResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsReadResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsListManyResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsStatResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsStatManyResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsMkdirResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsSearchResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsGrepResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsGitStatusResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsDiffResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsOpenResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsOpenInResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsRevealResponseSchema),
  ],
} as const;

export function transformOpenApiDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const paths = asRecord(document['paths']);
  if (paths === undefined) return document;

  patchFileUpload(paths);
  patchFileDownload(paths);
  patchKapSpec(paths);
  patchSessionExport(paths);
  patchSessionAction(paths);
  patchAgentAction(paths);
  patchFsAction(paths);
  patchFsDownload(paths);
  patchWorkspaceFsContent(paths);

  return document;
}

function patchKapSpec(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/kap.md', 'get');
  if (operation === undefined) return;
  setResponse(operation, '200', {
    description: 'Built-in Kimi Agent Protocol (KAP) Markdown specification',
    content: {
      'text/markdown': {
        schema: { type: 'string' },
      },
    },
  });
}

function patchSessionExport(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/export', 'post');
  if (operation === undefined) return;

  setResponse(operation, '200', {
    description: 'Session export archive or JSON error envelope',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      'cache-control': headerString(),
    },
    content: {
      'application/zip': {
        schema: binarySchema,
      },
      ...jsonContent(errorEnvelopeSchema),
    },
  });
}

function patchFileUpload(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/files', 'post');
  if (operation === undefined) return;

  operation['requestBody'] = {
    required: true,
    content: {
      'multipart/form-data': {
        schema: fileUploadMultipartSchema,
      },
    },
  };
}

function patchFileDownload(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/files/{file_id}', 'get');
  if (operation === undefined) return;

  setResponse(operation, '200', {
    description: 'Binary file download',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      etag: headerString(),
    },
    content: {
      'application/octet-stream': {
        schema: binarySchema,
      },
    },
  });
  setResponse(operation, '404', {
    description: 'File not found',
    content: jsonContent(errorEnvelopeSchema),
  });
}

function patchSessionAction(paths: Record<string, unknown>): void {
  const internalPath = '/api/v1/sessions/{tail}';
  const pathItem = asRecord(paths[internalPath]);
  const operation = asRecord(pathItem?.['post']);
  if (pathItem === undefined || operation === undefined) return;

  projectSessionAction(
    paths,
    pathItem,
    'cancel',
    'runSessionCancelAction',
    sessionCancelResponseSchema,
    cancelSessionBodySchema,
  );
  projectSessionAction(
    paths,
    pathItem,
    'wait',
    'runSessionWaitAction',
    waitSessionResponseSchema,
    waitSessionBodySchema,
  );
  projectSessionAction(
    paths,
    pathItem,
    'continue',
    'runSessionContinueAction',
    sessionContinueResponseSchema,
  );
  projectSessionAction(
    paths,
    pathItem,
    'archive',
    'runSessionArchiveAction',
    archiveSessionResponseSchema,
  );
  projectSessionAction(
    paths,
    pathItem,
    'delete',
    'runSessionDeleteAction',
    deleteSessionResponseSchema,
  );
  projectSessionAction(
    paths,
    pathItem,
    'reload',
    'runSessionReloadAction',
    getSessionResponseSchema,
  );
  projectSessionAction(
    paths,
    pathItem,
    'takeover',
    'runSessionTakeoverAction',
    takeoverSessionResponseSchema,
  );
  delete paths[internalPath];
}

function projectSessionAction(
  paths: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  action: string,
  operationId: string,
  successDataSchema: z.ZodTypeAny,
  bodySchema?: z.ZodTypeAny,
): void {
  const cloned = cloneRecord(pathItem);
  replacePathParamName(cloned, 'tail', 'session_id');
  const clonedOperation = asRecord(cloned['post']);
  if (clonedOperation !== undefined) {
    clonedOperation['operationId'] = operationId;
    if (bodySchema !== undefined) {
      clonedOperation['requestBody'] = {
        required: false,
        content: jsonContent(openApiDocumentJsonSchema(bodySchema)),
      };
    } else {
      delete clonedOperation['requestBody'];
    }
    const existingResponses = asRecord(clonedOperation['responses']);
    const existing200 = asRecord(existingResponses?.['200']);
    const existingContent = asRecord(existing200?.['content']);
    const existingSchema = asRecord(asRecord(existingContent?.['application/json'])?.['schema']);
    const existingOneOf = existingSchema?.['oneOf'];
    const okVariant = openApiDocumentJsonSchema(
      buildSuccessEnvelopeSchema(successDataSchema),
      'output',
    );
    const mergedSchema = Array.isArray(existingOneOf) && existingOneOf.length > 1
      ? { oneOf: [okVariant, ...existingOneOf.slice(1)] }
      : okVariant;
    setResponse(clonedOperation, '200', {
      description: `Session ${action} response`,
      content: jsonContent(mergedSchema),
    });
  }
  paths[`/api/v1/sessions/{session_id}:${action}`] = cloned;
}

function patchAgentAction(paths: Record<string, unknown>): void {
  const internalPath = '/api/v1/sessions/{session_id}/agents/{tail}';
  const pathItem = asRecord(paths[internalPath]);
  const operation = asRecord(pathItem?.['post']);
  if (pathItem === undefined || operation === undefined) return;

  const cloned = cloneRecord(pathItem);
  replacePathParamName(cloned, 'tail', 'agent_id');
  const clonedOperation = asRecord(cloned['post']);
  if (clonedOperation !== undefined) {
    clonedOperation['operationId'] = 'runAgentCloseAction';
  }
  paths['/api/v1/sessions/{session_id}/agents/{agent_id}:close'] = cloned;
  delete paths[internalPath];
}

function patchFsAction(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/{tail}', 'post');
  if (operation === undefined) return;

  operation['description'] = appendDescription(
    operation['description'],
    'The request and response schemas depend on the `fs:<action>` path tail and are represented as OpenAPI `oneOf` unions.',
  );
  operation['requestBody'] = {
    required: true,
    content: jsonContent(fsActionRequestSchema),
  };
  setResponse(operation, '200', {
    description: 'Filesystem action response',
    content: jsonContent(fsActionResponseSchema),
  });
}

function patchFsDownload(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/fs/{*}', 'get');
  if (operation === undefined) return;

  setResponse(operation, '200', {
    description: 'Binary workspace file download',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      etag: headerString(),
      'last-modified': headerString(),
    },
    content: {
      'application/octet-stream': {
        schema: binarySchema,
      },
    },
  });
  setResponse(operation, '206', {
    description: 'Partial binary workspace file download',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      'content-range': headerString(),
      etag: headerString(),
      'last-modified': headerString(),
    },
    content: {
      'application/octet-stream': {
        schema: binarySchema,
      },
    },
  });
  setResponse(operation, '304', {
    description: 'Not modified',
    headers: {
      etag: headerString(),
    },
  });
  setRawDownloadErrorResponses(operation);
}

function patchWorkspaceFsContent(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/fs:content', 'get');
  if (operation === undefined) return;
  setRawDownloadErrorResponses(operation);
}

function setRawDownloadErrorResponses(operation: Record<string, unknown>): void {
  for (const status of ['400', '403', '404', '409', '413', '500']) {
    setResponse(operation, status, {
      description: 'File download failed',
      content: jsonContent(errorEnvelopeSchema),
    });
  }
}

function getOperation(
  paths: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> | undefined {
  const pathItem = asRecord(paths[path]);
  if (pathItem === undefined) return undefined;
  return asRecord(pathItem[method]);
}

function setResponse(
  operation: Record<string, unknown>,
  statusCode: string,
  response: Record<string, unknown>,
): void {
  const responses = asRecord(operation['responses']) ?? {};
  responses[statusCode] = response;
  operation['responses'] = responses;
}

function jsonContent(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    'application/json': {
      schema,
    },
  };
}

function headerString(): Record<string, unknown> {
  return {
    schema: {
      type: 'string',
    },
  };
}

function headerInteger(): Record<string, unknown> {
  return {
    schema: {
      type: 'integer',
    },
  };
}

function appendDescription(existing: unknown, extra: string): string {
  if (typeof existing !== 'string' || existing.length === 0) return extra;
  return `${existing} ${extra}`;
}

function replacePathParamName(
  container: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const params = container['parameters'];
  if (Array.isArray(params)) {
    for (const param of params) {
      const record = asRecord(param);
      if (record?.['in'] === 'path' && record['name'] === from) {
        record['name'] = to;
      }
    }
  }

  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const operation = asRecord(container[method]);
    if (operation !== undefined) {
      replacePathParamName(operation, from, to);
    }
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}
